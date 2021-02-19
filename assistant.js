'use strict';

// process.env['NODE_CONFIG_DIR'] = __dirname + '/config/';
const config   = require('config');

// our less decisive defs are moved here:
const { logger, debugLevel } = require('./toolbox');

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
function sessionLookup(conversationId) {
    if (sessionsTable[conversationId] === undefined
        || sessionsTable[conversationId] == null) 
    {
        logger.debug(`sessionLookup: Conversation ${conversationId} was not found in our sessionsTable`);
        return null;
    }
    const obj = sessionsTable[conversationId];
    const sid = obj['session_id'];
    // check expiry
    const now_time = new Date().getTime() / 1000;
    if (now_time > obj['expiry']) {
        sessionTerminate(conversationId);
        logger.debug(`sessionLookup: Conversation ${conversationId} points to an expired session_id ${sid}`);
        return null;
    }
    else {
        logger.debug(`sessionLookup: Conversation ${conversationId} found and session_id ${sid} can be resumed`);
        return obj;
    }
}

function sessionTerminate(conversationId) {
    delete sessionsTable[conversationId];
}

// extend expiration time on session activity
function sessionExtendExpiry(conversationId) {
    var exp_time = sessionTimeout + new Date().getTime() / 1000;
    sessionsTable[conversationId]['expiry'] = exp_time;
    return sessionsTable[conversationId];
}

// this is just a placeholder for real func with DB backend
function sessionCreate(conversationId, wasObj) {
    var exp_time = sessionTimeout + new Date().getTime() / 1000;
    wasObj['expiry'] = exp_time;
    sessionsTable[conversationId] = wasObj;
    
    // the structure of the WAS object should be as following:
    // was = { 
    //         fromAddress :    ref['from'],
    //         session_id :     new_sid,
    //         expiry :         exp_time
    //     };

    logger.debug(`sessionCreate: Session entry created for ${conversationId}: ` + JSON.stringify(wasObj));
    return wasObj;
}

// async function with try-catch wrapper around Promise
async function assistant_createSession (ibMessageObj) {
    const conversationId = ibMessageObj['conversationId'];
    logger.debug(`assistant_createSession: Session creation requested for conversation ${conversationId}`);
    await IWA_assistantV2.createSession( { assistantId: IWA_assistantId } )
    .then(async (res) => {
        const session_id     = res.result.session_id;
        sessionCreate(conversationId, {
            'session_id' : session_id,
            'fromAddress': ibMessageObj['from']
        });
        logger.debug(`assistant_createSession: Session ${session_id} created for conversation ${conversationId}\n`+
            `Watson createSession Response: ` + JSON.stringify(res.result));
    })
    .catch((err) => {
        logger.error(`Failed in assistant_createSession() for conversation ${conversationId}: `, err);
        throw(Error(err));
    });
    return sessionExtendExpiry(conversationId);    
}

// sends a message over already created session and collect the response
async function assistant_exchangeMessage (ibMessageObj, textMsg) {
    const conversationId = ibMessageObj['conversationId']; 
    logger.debug(`assistant_exchangeMessage: Message from conversation ${conversationId} = '${textMsg}' queued for delivery to Watson`);
    var was = sessionLookup(conversationId);
    var result;
    if (! was) {
        was = await assistant_createSession(ibMessageObj);
    }
    logger.debug(`got session object: ` + ( was ? JSON.stringify(was) : 'null'));
    if (! was) {
        logger.debug(`cannot send witout a session`);
        return;
    }
    // send message to 
    await IWA_assistantV2.message({
        assistantId: IWA_assistantId,
        sessionId:   was.session_id,
        input:     { text: textMsg },
    })
    .then(async (res) => {
        logger.info(`Assistant Response\n`+ JSON.stringify(res.result, null, 2));
        // TODO: perform some checks here
        result = res.result;
    })
    .catch((err) => {
        logger.error(`Failed in assistant_createSession() for conversation ${conversationId}: `, err);
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
// exports.assistant_createSession = assistant_createSession;
exports.assistant_exchangeMessage = assistant_exchangeMessage;
//
exports.wat_serialize_options = wat_serialize_options
exports.wat_button_widget = wat_button_widget


