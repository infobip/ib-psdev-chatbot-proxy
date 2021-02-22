'use strict';

// process.env['NODE_CONFIG_DIR'] = __dirname + '/config/';
const config   = require('config');

const jsoning = require('jsoning');

// our less decisive defs are moved here:
const { logger, debugLevel } = require('./toolbox');

// sessions persistence (FIXME: this is very lite and limited)
const database = new jsoning(config.get("SDB_file"));

const AssistantV2 = require('ibm-watson/assistant/v2');
const { IamAuthenticator } = require('ibm-watson/auth');

// IBM Watson Assistant objects init.
const IWA_assistantId = config.get('IWA_assistantId');
const IWA_assistantV2 = new AssistantV2({
    authenticator: new IamAuthenticator({ 
        apikey: config.get('IWA_apiKey') }),
    serviceUrl: config.get('IWA_serviceURL'),
    version: config.get('IWA_apiVersion'),
    headers: {
        'X-Watson-Learning-Opt-Out': 'true'
      }    
});

// ---

// until we introduce Redis or Mongo we store mappings in this hash
// main key is IB Conversations' conversationId
var sessionsTable = {};
const sessionTimeout = config.get('IWA_sessionTimeout');

// check for session_id for given conversationId
// TODO: expiration is also checked
async function sessionLookup(conversationId) {
    logger.debug(`sessionLookup: Here in sessionLookup for ${conversationId} ...`);
    var was;
    // check if we have it cached
    if (sessionsTable.hasOwnProperty(conversationId)) {
        was = sessionsTable[conversationId];
        logger.debug(`sessionLookup: ===> found cached session object`);        
    }
    else {
        logger.debug(`sessionLookup: ===> not having cached session object`);        
        // try getting the value from the database
        was = await database.get(conversationId);
        if (was) {
            logger.debug(`sessionLookup: Database lookup for ${conversationId} returned session record: `+JSON.stringify(was));
            sessionsTable[conversationId] = was; // cache it
        }
        else {
            logger.debug(`sessionLookup: ===> not having it in the database either`);        
            // not in cache, not in database --> it is a fresh one: needs to go through createSession
            return null;
        }
        
    }
    if (! was) {
        logger.debug(`sessionLookup: Conversation ${conversationId} was not found in our sessionsTable`);
        return null;
    }
    const session_id = was['session_id'];
    // check expiry
    const now_time = new Date().getTime() / 1000;
    if (now_time > was['expiry']) {
        sessionTerminate(conversationId);
        logger.debug(`sessionLookup: Conversation ${conversationId} points to an expired session_id ${session_id}`);
        return null;
    }
    else {
        logger.debug(`sessionLookup: Conversation ${conversationId} found and session_id ${session_id} can be resumed`);
        return was;
    }
}

function sessionTerminate(conversationId) {
    delete(sessionsTable[conversationId]);
    database.delete(conversationId);
}

// extend expiration time on session activity
async function sessionExtendExpiry(conversationId) {
    var new_exp_time = sessionTimeout + new Date().getTime() / 1000;
    sessionsTable[conversationId]['expiry'] = new_exp_time;
    // overwrite the existing object in the database
    database.set(conversationId, sessionsTable[conversationId]);
    return sessionsTable[conversationId];
}

// this is just a placeholder for real func with DB backend
async function sessionCreate(conversationId, was) {
    var exp_time = sessionTimeout + new Date().getTime() / 1000;
    was['expiry'] = exp_time;
    sessionsTable[conversationId] = was;
    
    // the structure of the WAS object should be as following:
    // was = { 
    //         fromAddress :    ref['from'],
    //         session_id :     new_sid,
    //         expiry :         exp_time
    //     };

    await database.set(conversationId, was);
    logger.debug(`sessionCreate: Session entry created for ${conversationId}: ` + JSON.stringify(was));
    return was;
}

// async function when called from another async fuction should block
// until its result is ready e.g. promise yields resolve or reject
async function assistant_createSession (conversationId, fromAddress) {
    var was;
    logger.debug(`assistant_createSession: Session creation requested for conversation ${conversationId}`);
    await IWA_assistantV2.createSession( { assistantId: IWA_assistantId } )
    .then(async (res) => {
        const session_id     = res.result.session_id;
        was = await sessionCreate(conversationId, {
            'session_id' : session_id,
            'fromAddress': fromAddress
        });
        logger.debug(`assistant_createSession: Session ${session_id} created for conversation ${conversationId}\n`+
            `Watson createSession Response: ` + JSON.stringify(res.result));
    })
    .catch((err) => {
        logger.error(`Failed in assistant_createSession() for conversation ${conversationId}: `, err);
        throw(Error(err));
    });
    sessionExtendExpiry(conversationId);
    return was;
}

async function assistant_deleteSession (conversationId, session_id) {
    logger.debug(`assistant_deleteSession: Session deletion requested for conversation ${conversationId}`);
    if (! session_id) { var was = sessionLookup(conversationId); session_id = was.session_id }
    await IWA_assistantV2.deleteSession( { assistantId: IWA_assistantId, sessionId: session_id } )
    .then(async (res) => {
        sessionTerminate(conversationId);
        logger.debug(`assistant_deleteSession: Session ${session_id} deleted for conversation ${conversationId}\n`+
            `Watson deleteSession Response: ` + JSON.stringify(res.result));
    })
    .catch((err) => {
        logger.error(`Failed in assistant_deleteSession() for conversation ${conversationId} / session ${session_id}: `, err);
        throw(Error(err));
    });
}

// sends a message over already created session and collect the response
async function assistant_exchangeMessage (ibMessageObj, textMsg) {
    const conversationId = ibMessageObj['conversationId']; 
    logger.debug(`assistant_exchangeMessage: Message from conversation ${conversationId} = '${textMsg}' queued for delivery to Watson`);
    var was = await sessionLookup(conversationId);
    logger.debug(`assistant_exchangeMessage: sessionLookup(${conversationId}) returned ${was}`);
    var result;
    if (! (was && was.hasOwnProperty('session_id'))) {
        logger.debug(`assistant_exchangeMessage: calling assistant_createSession() for conversation ${conversationId}`);
        was = await assistant_createSession(conversationId, ibMessageObj.from);
    }
    logger.debug(`got session object: ${was} = ` + ( was ? JSON.stringify(was) : 'null'));
    if (! (was && was.hasOwnProperty('session_id'))) {
        logger.debug(`cannot send witout a session`);
        return;
    }
    // send message to 
    await IWA_assistantV2.message({
        assistantId: IWA_assistantId,
        sessionId:   was.session_id,
        input:     { message_type: 'text', text: textMsg },
    })
    .then(async (res) => {
        // logger.info(`Assistant Response\n`+ JSON.stringify(res.result, null, 2));
        logger.info(`Assistant Full Result\n`+ JSON.stringify(res, null, 2));
        // TODO: perform some checks here
        result = res.result;
    })
    .catch((err) => {
        logger.error(`Failed in assistant_exchangeMessage() for conversation ${conversationId}: `, err);
        throw(Error(err));
    });
    return result;
}

// ---

// function that returns a string when passed generic object
// of a Watson Assistant "options" array containing one
function wat_serialize_options(genericItem) {
    if (genericItem.hasOwnProperty("options") && genericItem.hasOwnProperty("title")) {
        const options_in = genericItem['options'];    
        var options_out = [];
        for (const key in options_in) {
            if (options_in[key].hasOwnProperty('label')) {
                var oneopt = options_in[key];
                options_out.push(oneopt['label'] + " (entrer: " + oneopt['value'].input.text + ")");
            }
            else {
                options_out.push(JSON.stringify()); // fallback
            }
        }
        return genericItem['title'] + " [" + options_out.join(', ') + "]";
    }
    else {
        return JSON.stringify(genericItem, null, 2); // fallback
    }
}

// function that returns a button widget object from 
// a Watson Assistant "options" array containing one
function wat_button_widget(genericItem) {
    var btnObj = {};
    if (genericItem.hasOwnProperty("options") && genericItem.hasOwnProperty("title")) {
        btnObj.text = genericItem['title'];
        const options_in = genericItem['options'];
        var options_out = [];
        for (const key in options_in) {
            if (options_in[key].hasOwnProperty('label')) {
                var oneopt = options_in[key];
                options_out.push({ title: oneopt['label'], type: "POSTBACK", payload: oneopt['value'].input.text });
            }
        }
        btnObj.buttonPayloads = options_out;
    }
    return btnObj;
// sample:
// ---------
// button: {
//     text: "Just a channel capability test. Some text to show above the buttons",
//     buttonPayloads: [
//         { title: "Option 1ere", type: "POSTBACK", payload: "option 1" },
//         { title: "Option 2eme", type: "POSTBACK", payload: "option 2" },
//         { title: "Option 3eme", type: "POSTBACK", payload: "option 3" }                                    
//     ]
// }

}



// exports.sessionCreate = sessionCreate;
exports.sessionLookup = sessionLookup;
exports.sessionTerminate = sessionTerminate;
exports.assistant_createSession = assistant_createSession;
exports.assistant_deleteSession = assistant_deleteSession;
exports.assistant_exchangeMessage = assistant_exchangeMessage;
//
exports.wat_serialize_options = wat_serialize_options
exports.wat_button_widget = wat_button_widget


