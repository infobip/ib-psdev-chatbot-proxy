'use strict';

// Main AWB ChatBot Proxy application source code file

// Node >= v14 needs this not to throw "ReferenceError: require is not defined"
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);

const axios = require('axios'),
      express = require('express');
const app = express();

// process.env['NODE_CONFIG_DIR'] = __dirname + '/config/';
const config   = require('config');

const flowcontrol = require('./flowcontrol');

// our less decisive defs are moved here:
const { appName, appHost, appPort, logger, Step, bipHeaders,
    SWA_KWord, RE_SWA_KWord, myBotName_LC, myBotName_WA,
    debugFrom, debugWebHook, debugLevel,
    current_timestamp, sleep
} = require('./toolbox');

// IBM Watson Assistant related stuff:
const { sessionLookup, sessionTerminate, assistant_exchangeMessage,
    assistant_deleteSession, wat_serialize_options, wat_button_widget 
} = require('./assistant');

const appStartupTime = current_timestamp();

// we need our Bot Id to do stuff, each channel its own ex-bot
var myBotId_LC = ""; // assigned response from GET bots (LC)
var myBotId_WA = ""; // assigned response from GET bots (WA)

// async function with try-catch wrapper around Promise
const getBotIds = async () => {

    var get_url;
    get_url = config.get('BIP_serviceURL')+'/ccaas/1/bots';
    logger.debug(`Preparing the GET call to: ${get_url}`);

    var bipHeadersGet = bipHeaders;
    // when troubleshooting (use a new webhook.site inbox)
    if (0 && debugLevel) {
        get_url = debugWebHook + "/bots";
        delete(bipHeadersGet['Authorization']);
    } // debug

    try {
        const response = await axios.get(get_url, {'headers': bipHeadersGet});
        logger.debug("getBotIds result code: " +  response.status);

        var keys = Object.keys(response.data);
        var myBotObject = {};
        if (response.data.hasOwnProperty('bots')) {
            var botsArray = response.data['bots'];
            botsArray.forEach(bot => {
                if (myBotName_LC === bot['displayName']) {
                    myBotId_LC = bot['id'];
                }
                else if (myBotName_WA === bot['displayName']) {
                    myBotId_WA = bot['id'];
                }
            });
        }
    }
    catch (err) {
        logger.error('Error while getting bots identifiers from Infobip Conversations', err);
        throw Error(err);
    }
};


// resolve channel identifier to our botId
function botIdforChannel(channel) {
    switch(channel.toUpperCase()) {
        case "LIVECHAT":
        case "LIVE_CHAT":
            return myBotId_LC;
        case "WHATSAPP":
            return myBotId_WA;
        default:
            return; // undefined
    }
}

// sending a single Text Message to IB Conversations
function convPostMessageTextSingle(xResponse, ibMessageObj) {
    // get original Bip Headers and tweak em
    var bipHeadersPostMsg = bipHeaders;
    bipHeadersPostMsg['x-agent-id'] = botIdforChannel(ibMessageObj['channel']);
    bipHeadersPostMsg['Content-Type'] = 'application/json';

    var conversationId = ibMessageObj['conversationId']; 
    var post_url;
    post_url = config.get('BIP_serviceURL')+"/ccaas/1/conversations/"+conversationId+"/messages";
    logger.debug(xResponse.locals.flowControlId + ` Preparing the POST call to: ${post_url}`);

    // when troubleshooting (use a new webhook.site inbox)
    if (debugLevel) {
        post_url = debugWebHook + "/conversations/"+conversationId+"/messages";
        delete(bipHeadersPostMsg['Authorization']);
    } // debug

    logger.debug(xResponse.locals.flowControlId + ` Performing the POST call to: ${post_url}`);
   
    // const response = 
    axios.post(post_url, ibMessageObj, {'headers': bipHeadersPostMsg})
    .then((res) => {
        logger.debug(xResponse.locals.flowControlId + ` POST->message result status: ` + res.status);
        return true;
    })
    .catch((err) => {
        if (err.response) {
            logger.error(`Server Error while returning reply message on conversation ${conversationId}: `, err);    
        }
        else {
            logger.error(`Error while routing conversation ${conversationId} on Infobip Conversations: `, err);
            throw Error(err);
        }
        return false;
    });
}

// interpreting playbook and sending as many Messages as enqueued
async function convPostMessageMany(xResponse, conversationId, channel, replyScenario) {
    // get original Bip Headers and tweak em
    var bipHeadersPostMsg = bipHeaders;
    bipHeadersPostMsg['x-agent-id'] = botIdforChannel(channel);
    bipHeadersPostMsg['Content-Type'] = 'application/json';

    logger.info("Reply scenario with " + replyScenario.length + " parts prepared for delivery");

    var post_url;
    post_url = config.get('BIP_serviceURL')+"/ccaas/1/conversations/"+conversationId+"/messages";
    logger.debug(xResponse.locals.flowControlId + ` Preparing the POST call to: ${post_url}`);

    // when troubleshooting (use a new webhook.site inbox)
    if (debugLevel) {
        post_url = debugWebHook + "/conversations/"+conversationId+"/messages";
        delete(bipHeadersPostMsg['Authorization']);
    } // debug

    logger.debug(xResponse.locals.flowControlId + ` Performing the POST call to: ${post_url}`);
   
    var noErrorHappened = true;
    var itemSeqNo = 0;
    for await (const replyItem of replyScenario) {
        itemSeqNo++;
        logger.debug(xResponse.locals.flowControlId + ` Handling reply scenarion item ${itemSeqNo}: ` + JSON.stringify(replyItem));
        if (Step.REPLY == replyItem.step) {
            const ibMessageObj = replyItem.reply;
            try {
                logger.debug(xResponse.locals.flowControlId + ` attemptint to POST->message(...)`);
                const response = await axios.post(post_url, ibMessageObj, {'headers': bipHeadersPostMsg});
                logger.debug(xResponse.locals.flowControlId + ` POST->message(...) result status: ` + response.status);
            }
            catch (err) {
                noErrorHappened = false;
                if (err.response) {
                    logger.error(`Server Error while messaging conversation ${conversationId} on Infobip Conversations: `, err);    
                }
                else {
                    logger.error(`Error while messaging conversation ${conversationId} on Infobip Conversations: `, err);
                    throw Error(err);
                }
            }
            if (! noErrorHappened) break; // we stop loop execution if there is an error
        }
        if (Step.PAUSE == replyItem.step) {
            const ms = replyItem.pause;
            logger.debug(xResponse.locals.flowControlId + ` Pausing for ${ms} ms`);
            await sleep(ms);
        }
    }
    if (noErrorHappened) {
        logger.debug(xResponse.locals.flowControlId + ` reply scenario finished`);
    }
    return noErrorHappened;
}



// perform tagging and subsequent routing of Conversation
async function convRouteConv(xResponse, conversationId, tagsArray) {
    // get original Bip Headers and tweak em
    var bipHeadersPost = bipHeaders;

    var post_url; // we reuse this var for /tags and /route URLs
    post_url = config.get('BIP_serviceURL')+"/ccaas/1/conversations/"+conversationId+"/tags";
    logger.debug(xResponse.locals.flowControlId + ` Preparing the POST call(s) to: ${post_url}`);

    // when troubleshooting (use a new webhook.site inbox)
    if (debugLevel) {
        post_url = debugWebHook + "/conversations/"+conversationId+"/tags";
        delete(bipHeadersPost['Authorization']);
    } // debug

    var noErrorHappened = true;
    for await (const tagName of tagsArray) {
            try {
            logger.debug(xResponse.locals.flowControlId + ` attemptint to POST->tags(${tagName})`);
            const response = await axios.post(post_url, {'tagName': tagName} , {'headers': bipHeadersPost});
            logger.debug(xResponse.locals.flowControlId + ` POST->tags(${tagName}) result status: ` + response.status);
        }
        catch (err) {
            noErrorHappened = false;
            if (err.response) {
                logger.error(`Server Error while tagging conversation ${conversationId} on Infobip Conversations: `, err);    
            }
            else {
                logger.error(`Error while tagging conversation ${conversationId} on Infobip Conversations: `, err);
                throw Error(err);
            }
        }
        if (! noErrorHappened) break; // we stop loop execution if there is an error
        await sleep(2000);
    }

    if (noErrorHappened) {
        try {
            post_url = post_url.replace(/\/tags$/, '/route');
            logger.debug(xResponse.locals.flowControlId + ` attemptint to POST->route call to: ${post_url}`);
            const response = await axios.post(post_url, {}, {'headers': bipHeadersPost});
            logger.debug(xResponse.locals.flowControlId + ` POST->route result status: ` + response.status);
        }
        catch (err) {
            noErrorHappened = false;
            if (err.response) {
                logger.error(`Server Error while routing conversation ${conversationId} on Infobip Conversations: `, err);    
            }
            else {
                logger.error(`Error while routing conversation ${conversationId} on Infobip Conversations: `, err);
                throw Error(err);
            }
        }
    }
    return noErrorHappened;
}


const initMain = async () => {
    try {
        // initialize our server side: express()
        // ==========================================
        logger.info(`Application ${appName} starting`);
    
        // wait to http request to finish
    	await getBotIds();
        
        if (myBotId_LC || myBotId_WA) {
            logger.info("SUCCESS: Infobip Conversations returned our active botId's");
            if (myBotId_LC)
                logger.info(`Bot.ID for LiveChat = ${myBotId_LC}, Bot.displayName = ${myBotName_LC}`);
            if (myBotId_WA)
                logger.info(`Bot.ID for WhatsApp = ${myBotId_WA}, Bot.displayName = ${myBotName_WA}`);
        }
        else {
            logger.error("FALIURE: couldn't get any active botId from Infobip Conversations");
            process.exit(1);
        }

        // looks better if we do not start too quickly
        await sleep(1500);
    
        // let's configure our Chatbot Proxy HTTP server listener
        app.listen(appPort, appHost, () => {
            logger.info(`Application ${appName} listening at http://${appHost}:${appPort}/`)
        });      
    }
    catch(err) {
        console.error(err);
        logger.error(`Application ${appName} startup failure: `, err);
    }
};

// this is just initialization of the express app objects

// express to assign unique flow tracking identifier to each request
app.use(flowcontrol({includeDate: true, randLength: 8}));

// express should give us instantiated JSON objects
app.use(express.json());


app.get('/', (req, res) => {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logger.info(`${appName} serving GET / for client at ${ip}`);

    // craft some forward message including requester's IP and current time
    var tstmp = current_timestamp();
    res.send(`Hello client connecting from ${ip}, this is "${appName}", up since ${appStartupTime}, reporting at ${tstmp}`);
})


// main handler of POST / requests
app.post('/', async (xRequest, xResponse) => {
    var ip = xRequest.headers['x-forwarded-for'] || req.socket.remoteAddress;    
    logger.info(`Received POST / request from client at ${ip} flow control Id: ` + xResponse.locals.flowControlId);
    logger.debug("POST request ["+xResponse.locals.flowControlId+"] received with data:\n" + JSON.stringify(xRequest.body, null, 2));

    // CCaaS API for external bots does not require any reply for forwarded messages
    xResponse.send("");      // send back empty response, with status 200 = OK

    var rb = xRequest.body;
    var inboundTextMsg = rb['content']['text'];
    var conversationId = rb['conversationId'];
    var forwardTextMsg = '';
    var nextStep = null;   // takes values from Step enum
    var existingOrNew = '';
    var allResponses = []; // output buffer
    var conversationAborted = false;

    // check do we have a session_id for this conversationId
    var was = sessionLookup(rb['conversationId']);
    if (was) { existingOrNew = "existing" } else { existingOrNew = "new" }

    // trim whitespace front and back from inbound message string
    inboundTextMsg = inboundTextMsg.replace(/\s+/g, ' ').replace(/^\s*|\s*$/g, '');

    // first check if the keyword is provided and if this is the only word
    if (inboundTextMsg.match(RE_SWA_KWord)) {
        logger.info(`Registered keyword '${SWA_KWord}' received on ${existingOrNew} conversationId: ${conversationId}`);
        inboundTextMsg = inboundTextMsg.replace(RE_SWA_KWord, '');
        if (inboundTextMsg.length == 0) {
            logger.info(`  ... as it is the only word received, responding with session status message`);
            if (was) {
                forwardTextMsg = `This conversation is connected to Watson Assistant via ${appName} already.\n`
                + `Infobip ConversationId=${conversationId}\n`;
                + 'Watson Assistant SessionId=' + was['session_id'];
            }
            else {
                // letting it fall through to LOOPTEST case
                inboundTextMsg = SWA_KWord;
            }
        }
    }

    if (inboundTextMsg.toUpperCase() == "STOP") {
        logger.info(`STOP received on ${existingOrNew} conversationId: ${conversationId}`);
        conversationAborted = true;
        if (was) sessionTerminate(rb['conversationId']);
        forwardTextMsg = `Chatbot Proxy has terminated this session with Virtual Assistant on your request.`
        nextStep = Step.STOP;
    }
    else if (inboundTextMsg.toUpperCase() == "LOOPTEST" || inboundTextMsg.match(RE_SWA_KWord)) {
        logger.info(`LOOPTEST or KEYWORD received on this conversationId: ${conversationId}`);
        // respond with internally generated response message (loopback testing)
        var tstmp = current_timestamp();
        forwardTextMsg = `Hello this is "${appName}", I have received your '${inboundTextMsg}' at ${tstmp}.\nThis is an automated loopback response.`;
        nextStep = Step.REPLY;
    }
    else {
        logger.debug(`Regular message received on ${existingOrNew} conversationId: ${conversationId}`);
        nextStep = Step.WATSON;
    }

    if (nextStep == Step.WATSON) {
        // do the thing with Watson ...
        const aMsg = await assistant_exchangeMessage(rb, inboundTextMsg);
        
        logger.info(xResponse.locals.flowControlId+` We've got Watson Assistant's response: ` +  JSON.stringify(aMsg));

        if (aMsg) { // aMsg ~ response.result
            // map Watson's response to our reply scenario
            // TODO: do some error checking here
            const rro = aMsg.output;
            const rog = rro.generic;
            var pauseMillis = 0;
            var forwardBtn = '';
            var redirToAgent = false;
            logger.info(xResponse.locals.flowControlId+` analyzing Watson Assistant's response...`);
            for await (const ogi of rog) {
                if (ogi.response_type == "text") {
                    forwardTextMsg = ogi.text;
                    nextStep = Step.REPLY;
                }
                else if (ogi.response_type == "connect_to_agent") {
                    forwardTextMsg = ogi.agent_available.message;
                    // get intent for tagging
                    redirToAgent = true;
                    nextStep = Step.REPLY;
                }
                else if (ogi.response_type == "pause") {
                    pauseMillis = 0 + ogi.time;
                    forwardTextMsg = "";
                    nextStep = Step.PAUSE;
                }
                else if (ogi.response_type = "option") {
                    forwardTextMsg = wat_serialize_options(ogi);
                    if (rb['channel'] == "LIVE_CHAT") {
                        // respond with button widget -- LIVE_CHAT channel only
                        forwardBtn = wat_button_widget(ogi);
                    }
                    nextStep = Step.REPLY;
                }
                else {
                    forwardTextMsg = "(response type '"+ogi.response_type+"' not supported yet)";
                    nextStep = Step.REPLY;
                }
                // ----
                
                if (Step.REPLY == nextStep) {
                    // format OUTGOING message to Conversations
                    // generic key/values first:
                    var responseMessage = {
                        "from":           rb['to'],
                        "to":             rb['from'],
                        "channel":        rb['channel'],
                        "conversationId": rb['conversationId'],
                        "direction":      "OUTBOUND"
                    };

                    if (forwardTextMsg) {
                        responseMessage.contentType = "TEXT";
                        responseMessage.content = { "text": forwardTextMsg  }
                        forwardTextMsg = null // spent
                        // enqueue messages and pauses for scenario play / delivery
                        allResponses.push({step: nextStep, reply: responseMessage});
                    }

                    // specifics for button widget response (LIVECHAT only):
                    if (forwardBtn && rb['channel'] == "LIVE_CHAT") {
                        responseMessage.contentType = "BUTTON";
                        responseMessage.buttonType = "LIVECHAT";
                        responseMessage.content = {
                            'contentType': "BUTTON",
                            'buttonType':  "LIVECHAT",
                            'button':      forwardBtn
                        };
                        forwardBtn = null; // spent
                        // allResponses.push({step: nextStep, reply: responseMessage});
                    }
                  
                    if (pauseMillis == 0) {
                        allResponses.push({step: Step.PAUSE, pause: 250});
                    }
                }
                else if (Step.PAUSE == nextStep) {
                    allResponses.push({step: Step.PAUSE, pause: pauseMillis});
                    pauseMillis = 0;
                }

            }
            if (redirToAgent) nextStep = Step.ROUTE;
        }
        else {
            // Watson was not available - therefore we offer this as substitute
            if (inboundTextMsg.match('agent|route')) {
                forwardTextMsg = "Virtual Assistant is momentarily not available. Chatbot Proxy will route this conversation to a Human Agent.";
                nextStep = Step.ROUTE;
            }
            else {
                // register session ...
                forwardTextMsg = "Virtual Assistant is momentarily not available. Please respond with 'agent' to have this conversation routed to a Human Agent.";
                nextStep = Step.REPLY;
            }
        }
    }

    var nreplies = allResponses.length;
    logger.debug(xResponse.locals.flowControlId+` forwardTextMsg=${forwardTextMsg} allResponses#=${nreplies} nextStep=${nextStep}`);
    logger.info(xResponse.locals.flowControlId+` allResponses: \n` + JSON.stringify(allResponses, null, 2));

    if (forwardTextMsg) {
        // craft the reply message TEXT response
        var responseMessage = {
            "from":              rb['to'],
            "to":                rb['from'],
            "channel":           rb['channel'],
            "contentType":       "TEXT",
            "conversationId":    rb['conversationId'],
            "direction":         "OUTBOUND",
            "content": { "text": forwardTextMsg  }
        };
        convPostMessageTextSingle(xResponse, responseMessage);
        forwardTextMsg = ''; // spent
    }
    else if (allResponses.length > 0) {
        convPostMessageMany(xResponse, conversationId, rb['channel'], allResponses);
        allResponses = [];
    }

    if (Step.ROUTE == nextStep) {
        if (await convRouteConv(xResponse, conversationId, ['routingInfo'])) {
            logger.info(`Tagging and routing of conversationId: ${conversationId} was successful.`);
        }
        else {
            logger.error(`Tagging and routing of conversationId: ${conversationId} was unsuccessful!`);
        }
        // TODO: schedule session cleanup from the SDB
    }

    if (Step.STOP == nextStep) {
        assistant_deleteSession(conversationId);
        logger.info(`For conversationId: ${conversationId} session terminated on STOP keyword.`);
    }

});

initMain();

