This is a small and very simple deployment script that allows us to automatically
deploy eg. komodoide.com whenever we push to our deployment branches.

It is designed specifically with static sites in mind, and will only work if
both deployer and deployment configurations are on the same server, in the same
parent directory.

For a site to be valid for deployment it must have a deploy.js library in its
root which exposes the following methods:

 * init(logger)
 * run(params, done)
 * schedule(branch, cron, deploy) - optional, if you want to schedule deployments
 via cron

To learn more about how this works please look at [deploy.js] on the komodo-website repository

   [deploy.js]: https://github.com/Komodo/komodo-website/blob/master/deploy.js
