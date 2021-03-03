// process.env['NODE_CONFIG_DIR'] = __dirname + '/config/';
const config = require("config");

// logger module
const winston = require("winston");

// HTTPs client
const axios = require("axios");

// (next) steps when dealing with inbound message
const Step = {
  DROP: "DROP",
  STOP: "STOP",
  REPLY: "REPLY",
  PAUSE: "PAUSE",
  ROUTE: "ROUTE",
  WATSON: "WATSON",
  LOOPTEST: "LOOPTEST"
};

// take "app" from the main module (via require)

var app;

// Environment and initial parameters
const env = process.env;
const appPort = config.get("NODE_PORT") || env["NODE_PORT"] || 3000;
const appHost = config.get("NODE_HOST") || env["NODE_HOST"] || "0.0.0.0";
const appName =
  config.get("NODE_APP_NAME") ||
  env["NODE_APP_NAME"] ||
  "AWB-chatbotProxy-TEST";

// in case we get interrupted log something
process.on("SIGTERM", () => {
  app.close(() => {
    logger.info(`Application ${appName} process terminated`);
  });
});

process.on("uncaughtException", (err) => {
  console.error("There was an uncaught error", err);
  logger.error(`Application ${appName} stopped on uncaught error`, err);
  process.exit(1); //mandatory (as per the Node.js docs)
});

// used when logging JSON objects (for debug purposes)
// as we want to redact them to avoid writing secrets to log files
// function omit(obj, key) {
//   const { [key]: ignore, ...rest } = obj;
//   return rest;
// }

axios.interceptors.request.use((request) => {
  var request_as_string = JSON.stringify(request);
  request_as_string = request_as_string.replace(
    /"Authorization":"([^"]|\\")+"/g,
    '"Authorization":"{{redacted}}"'
  );
  logger.debug("axios request:: " + request_as_string);
  return request;
});

axios.interceptors.response.use((response) => {
  var resp_code = response.status;
  var resp_headers = JSON.stringify(response.headers);
  var resp_data = JSON.stringify(response.data);
  logger.debug(
    `axios response:: status: ${resp_code} headers: ${resp_headers} data: ${resp_data}`
  );
  return response;
});

// Logger configuration
const logConfiguration = {
  format: winston.format.combine(
    //    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.printf(
      (info) => `[${info.timestamp}] ${info.level}: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      level: config.get("ConsoleLogLevel")
    }),
    new winston.transports.File({
      level: config.get("jsonLogLevel"), // 'error'
      filename: config.get("jsonLogFile")
    })
  ]
};

// Create the logger
const logger = winston.createLogger(logConfiguration);

// Secret Keys sourced from environment (CodeSandbox.io)
const BIP_authorization = process.env.BIP_authorization || config.get("BIP_authorization");

// prepare headers for IB API calls to CCaaS
const bipHeaders = {
  Accept: "application/json",
  Connection: "close",
  Authorization: BIP_authorization
};

// ---

// Shared WhatsApp account keyword to be removed from inbound message
const SWA_KWord = config.get("BIP_SWA_KWord");
const RE_SWA_KWord = RegExp("^\\s*" + SWA_KWord + "($|\\s*)", "i");

// our Bot names that we need to get the ID's for
const myBotName_LC = config.get("BIP_botName_LC");
const myBotName_WA = config.get("BIP_botName_WA");

// control over some debugging paramenters
const debugFrom = config.get("debugFrom");
const debugWebHook = config.get("debugWebHook");
var debugLevel = config.get("debugLevel");

// ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function current_timestamp() {
  var today = new Date();
  var tstmp =
    today.getFullYear() +
    "-" +
    ("0" + (today.getMonth() + 1)).slice(-2) +
    "-" +
    ("0" + today.getDate()).slice(-2) +
    " " +
    ("0" + today.getHours()).slice(-2) +
    ":" +
    ("0" + today.getMinutes()).slice(-2) +
    ":" +
    ("0" + today.getSeconds()).slice(-2);
  return tstmp;
}

// our import (app) and exports
module.exports = function (app_arg) {
  if (app_arg) {
    app = app_arg;
  }

  return {
    appPort: appPort,
    appHost: appHost,
    appName: appName,
    Step: Step,
    logger: logger,
    bipHeaders: bipHeaders,
    SWA_KWord: SWA_KWord,
    RE_SWA_KWord: RE_SWA_KWord,
    myBotName_LC: myBotName_LC,
    myBotName_WA: myBotName_WA,
    debugFrom: debugFrom,
    debugWebHook: debugWebHook,
    debugLevel: debugLevel,
    current_timestamp: current_timestamp,
    sleep: sleep
  };
};
