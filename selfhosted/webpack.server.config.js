const path = require("path");
const lambdaConfig = require("../webpack.lambda.config.js");

// Same bundling rules as the AWS lambda build (externals, uniwind rewrites, defines) - only the entry
// point and the output dir differ, so the two builds can never drift apart.
module.exports = {
  ...lambdaConfig,
  entry: {
    server: "./selfhosted/server.ts",
  },
  output: {
    ...lambdaConfig.output,
    path: path.resolve(__dirname, "..", "dist-selfhosted"),
  },
};
