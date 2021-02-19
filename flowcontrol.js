// middleware to assign flow control identifier

var random = require('randomstring');

var generate = function(options) {
    var dt = new Date();
    if (options) {
        var rndFlowId;
        if (options.randLength) {
            rndFlowId = random.generate(options.randLength);
        }
        else {
            rndFlowId = random.generate();
        }
        if (options.includeDate == true) {
            rndFlowId = dt.toISOString()+'-'+rndFlowId;
        }
        return rndFlowId;
    }
    return random.generate() + dt.toISOString();
}

module.exports = function (options) {
    return function (req, res, next) {
        // Implement the middleware function based on the options object
        res.locals.flowControlId = generate(options);
        next()
    }
}

