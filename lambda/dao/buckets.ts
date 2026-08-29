import { Utils_getEnv, Utils_isSelfHosted } from "../utils";

export const LftS3Buckets = {
  caches: "liftosaurcaches2",
  stats: "liftosaurstats",
  debugs: "liftosaurdebugs2",
  exceptions: "liftosaurexceptions2",
  storages: "liftosaurstorages",
  programs: "liftosaurprograms",
  assets: "liftosaurassets",
  images: "liftosaurimages2",
  userimages: "liftosauruserimages",
  static: "lftstatic",
};

export function getUserImagesPrefix(): string {
  if (Utils_isSelfHosted()) {
    return `${(process.env.HOST || "").replace(/\/+$/, "")}/userimages/`;
  }
  const env = Utils_getEnv();
  if (env === "dev") {
    return "https://stage.liftosaur.com/userimages/";
  } else {
    return "https://www.liftosaur.com/userimages/";
  }
}
