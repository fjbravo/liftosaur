const path = require("path");
const lambdaConfig = require("../webpack.lambda.config.js");

// Same bundling rules as the AWS lambda build (externals, uniwind rewrites, defines) - only the entry
// points and the output dir differ, so the two builds can never drift apart.
// All three entries ship in the same container image; compose picks one with the command.
module.exports = {
  ...lambdaConfig,
  entry: {
    server: "./selfhosted/server.ts",
    bootstrap: "./selfhosted/bootstrap/index.ts",
    cron: "./selfhosted/cron.ts",
  },
  output: {
    ...lambdaConfig.output,
    path: path.resolve(__dirname, "..", "dist-selfhosted"),
  },
};
