// Environment consistency (2026-10-25): the browser build and the server
// must describe the same deployment. Configuration-based: the same project
// id works as staging or production depending only on LUNA_ENV.
import { describe, it, expect } from "vitest";
import { serverConfigProblems, serverDeployment, deploymentMismatches, siteOrigin } from "../../shared/environment.js";
import { checkDeployment } from "../../src/app/session.js";

const SERVER = { LUNA_ENV: "staging", FIREBASE_PROJECT_ID: "proj-a", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-x@proj-a.iam.gserviceaccount.com", FIREBASE_STORAGE_BUCKET: "proj-a.firebasestorage.app", SITE_URL: "https://proj-a.netlify.app/" };
const client = (o = {}) => ({ environment: "staging", projectId: "proj-a", origin: "https://proj-a.netlify.app", ...o });

describe("server configuration", () => {
  it("a consistent server has no problems", () => {
    expect(serverConfigProblems(SERVER)).toEqual([]);
    expect(serverDeployment(SERVER)).toEqual({ environment: "staging", projectId: "proj-a", siteOrigin: "https://proj-a.netlify.app", problems: [] });
  });
  it("flags a missing / unknown LUNA_ENV, a missing project, and a credential or bucket from another project", () => {
    expect(serverConfigProblems({ ...SERVER, LUNA_ENV: "prod" })).toEqual(["LUNA_ENV is missing or not development / staging / production"]);
    expect(serverConfigProblems({ ...SERVER, FIREBASE_PROJECT_ID: "" })).toContain("FIREBASE_PROJECT_ID is missing");
    expect(serverConfigProblems({ ...SERVER, FIREBASE_CLIENT_EMAIL: "x@proj-b.iam.gserviceaccount.com" })).toEqual(["FIREBASE_CLIENT_EMAIL belongs to a different Firebase project"]);
    expect(serverConfigProblems({ ...SERVER, FIREBASE_STORAGE_BUCKET: "proj-b.appspot.com" })).toEqual(["FIREBASE_STORAGE_BUCKET belongs to a different Firebase project"]);
    expect(serverConfigProblems({ ...SERVER, FIREBASE_STORAGE_BUCKET: "custom-bucket-name" })).toEqual([]);
  });
  it("production needs an https SITE_URL; the same project id is fine as production (no hard-coded staging project)", () => {
    expect(serverConfigProblems({ ...SERVER, LUNA_ENV: "production", SITE_URL: "" })).toEqual(["SITE_URL must be the https address in production"]);
    expect(serverConfigProblems({ ...SERVER, LUNA_ENV: "production", SITE_URL: "https://app.example.ph" })).toEqual([]);
    expect(siteOrigin("not a url")).toBe(null);
  });
});

describe("browser vs server", () => {
  const server = serverDeployment(SERVER);
  it("agreeing build and server: nothing to report", () => {
    expect(deploymentMismatches(client(), server)).toEqual([]);
    expect(() => checkDeployment(server, client())).not.toThrow();
  });
  it("a different environment or Firebase project blocks", () => {
    expect(deploymentMismatches(client({ environment: "production" }), server)).toEqual(["environment"]);
    expect(deploymentMismatches(client({ environment: undefined }), server)).toEqual(["environment"]);
    expect(deploymentMismatches(client({ projectId: "proj-b" }), server)).toEqual(["project"]);
    expect(() => checkDeployment(server, client({ projectId: "proj-b" }))).toThrow(expect.objectContaining({ code: "deployment-mismatch", status: 503 }));
  });
  it("a misconfigured server blocks", () => {
    expect(deploymentMismatches(client(), serverDeployment({ ...SERVER, FIREBASE_CLIENT_EMAIL: "x@proj-b.iam.gserviceaccount.com" }))).toEqual(["server"]);
  });
  it("in production the page must be on SITE_URL (no old hostname); staging allows previews", () => {
    const prod = serverDeployment({ ...SERVER, LUNA_ENV: "production", SITE_URL: "https://app.example.ph" });
    expect(deploymentMismatches(client({ environment: "production", origin: "https://app.example.ph" }), prod)).toEqual([]);
    expect(deploymentMismatches(client({ environment: "production", origin: "https://proj-a.netlify.app" }), prod)).toEqual(["site"]);
    expect(deploymentMismatches(client({ origin: "https://deploy-preview-1--proj-a.netlify.app" }), server)).toEqual([]);
  });
  it("an older server without deployment info isn't blocked", () => {
    expect(deploymentMismatches(client(), undefined)).toEqual([]);
  });
});
