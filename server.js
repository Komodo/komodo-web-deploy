var server = new function()
{
    var express = require('express');
    var sys     = require('sys');
    var fs      = require('fs');
    var exec    = require('child_process').exec;
    var CronJob = require('cron').CronJob;
    var winston = require('winston');

    var deploying = {active: false};
    var queued = {};
    var app;

    var githubIps = ["207.97.227.253","50.57.128.197","108.171.174.178"];

    // Run the logger, which dumps everything to stdout and deployment.log
    var logger = new winston.Logger({
        transports: [
            new (winston.transports.Console)({ level: 'debug', colorize: true }),
            new (winston.transports.File)({ filename: __dirname + '/deployment.log', level: 'debug', json: false })
        ]
    });

    var init = function ()
    {
        // Initialize App and define how we parse the request body
        app = express();

        app.configure(function () {
            app.use(function (err, req, res, next)
            {
                logger.error(err.stack);
                next(err);
            });

            app.use(express.json());
            app.use(express.urlencoded());
            app.use(express.multipart());
        });

        // Bind our routes
        bindRoutes();

        // Bind schedulers
        bindSchedulers();

        // Launch the server
        var server = app.listen(8282, function()
        {
            logger.info('Listening on port %d', server.address().port);
        });

        // Handle server related errors
        server.on("error", function (err)
        {
            logger.error('express server error:', err.message);
        });
    };

    var bindRoutes = function()
    {
        app.post('/hooks/push', routeHookPush);
    };

    /**
     * Bind schedulers from sibling directories
     */
    var bindSchedulers = function()
    {
        // Scan the parent dir
        var files = fs.readdirSync(__dirname + "/..");
        for (k in files)
        {
            var file = files[k];
            if (file[0] == '.') continue;
            
            // Validate whether the current file/folder contains deploy.js
            var path = __dirname + "/../" + file
            if ( ! fs.existsSync(path + "/deploy.js")) continue;

            // Validate whether this deployerRunner has a schedule method
            var deployerRunner = require(path + "/deploy.js");
            if ( ! ("schedule" in deployerRunner)) continue;

            deployerRunner.init(logger);

            // Retrieve the branch name of the current repo
            (function(path, deployerRunner)
            {
                exec('cd "'+path+'" && git rev-parse --abbrev-ref HEAD', function(err, stdo, stde)
                {
                    if (err) return;

                    var branch = stdo.replace(/\s/g,'');

                    // Run the scheduler
                    logger.debug("Running scheduler for " + path);
                    deployerRunner.schedule(branch, CronJob, deploy);
                });
            })(path, deployerRunner);
        }
    };

    /**
     * Github event hook for push events
     */
    var routeHookPush = function(req, res)
    {
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (githubIps.indexOf(ip) == -1)
        {
            logger.warn("Request from non-whitelisted ip: " + ip, req.body);
            return res.send('');
        }

        logger.info("Received push event");

        // Parse relevant info
        var payload         = req.body;
        var repo            = payload.repository.name;
        var branch          = payload.ref.split("/").slice(-1).join("-");
        var deployerName    = [repo,branch].join("-");

        // Prepare object to be passed to deployerRunner
        var deployer = {
            name: deployerName,
            path: __dirname + "/../" + deployerName,
            repository: payload.repository.name,
            branch: payload.ref.split("/").slice(-1)[0]
        };

        logger.debug("Deployer data", deployer);

        // Validate whether we have a deployment for the current repo and branch
        fs.exists(deployer.path + "/deploy.js", function(exists)
        {
            logger.debug(deployer.path + " exists: " + exists);
            if ( ! exists) return;
            deploy(deployer);
        })

        res.send('');
    };

    /**
     * Perform a deployment
     */
    var deploy = function(deployer)
    {
        // Add to queue if a deployment is already in progress for this repo+branch
        if (deployer.name in deploying || deploying.active)
        {
            logger.info("Queueing " + deployer.name);
            queued[deployer.name] = true;
            return;
        }

        logger.info("Deploying " + deployer.name);
        deploying[deployer.name] = true;
        deploying.active = true;

        // Perform a git pull on the targeted deployment so we can execute
        // the latest version of deploy.js
        exec('cd "'+deployer.path+'" && git pull', function(err, stdo, stde)
        {
            logger.debug(stdo);

            if (err !== null)
            {
                logger.error("Git pull error ("+deployer.name+"): " + err);
                return;
            }

            // Invoke the actual deployment script
            var deployerRunner = require(deployer.path + "/deploy.js");
            deployerRunner.init(logger);
            deployerRunner.run(deployer, function(err)
            {
                if (err)
                {
                    logger.error("Error while deploying "+deployer.name+": " + err);
                }

                // All done, unblock this deployer
                delete deploying[deployer.name];
                deploying.active = false;

                logger.info("Done deploying " + deployer.name);

                // Run queued jobs
                for (var queuedDeployer in queued) break;
                if (queuedDeployer)
                {
                    logger.info("Running queued job: " + queuedDeployer.name, queuedDeployer);
                    delete queued[queuedDeployer.name];
                    deploy(queuedDeployer);
                }

            });
        });
    };

    // Catch uncaught exceptions and restart the server
    process.on('uncaughtException', function (err) {
        logger.error('uncaughtException: ' + err.message, err.stack);
        process.exit(1); // Forever should restart our process (if we're running it through ./daemon)
    });

    init();

}

