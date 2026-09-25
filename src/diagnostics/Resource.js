const { randomUUID } = require("crypto");
const token = (v, max = 64) =>
    typeof v === "string" && v.length <= max && /^[A-Za-z0-9._-]+$/.test(v) && !/[\r\n]/.test(v);

function create({ config = {}, platformId, localService = "aitoapi" } = {}) {
    const platform = token(platformId, 128);
    const configured = token(config.instanceId, 128);
    return {
        bootId: randomUUID(),
        deploymentId: token(config.deploymentId) ? config.deploymentId : "unassigned",
        environment: token(config.environment) ? config.environment : "unassigned",
        instanceId: platform ? platformId : configured ? config.instanceId : randomUUID(),
        instanceIdentitySource: platform ? "platform" : configured ? "configured" : "ephemeral",
        nodeLabel: token(config.nodeLabel) ? config.nodeLabel : null,
        service: localService,
    };
}

function fromEnvironment(env) {
    const config = {
        deploymentId: env.DIAG_DEPLOYMENT_ID,
        environment: env.DIAG_ENVIRONMENT,
        instanceId: env.DIAG_INSTANCE_ID,
        nodeLabel: env.DIAG_NODE_LABEL,
    };
    // No confirmed replica UID in this deployment. Host/service IDs are not replica IDs.
    const resource = create({ config });
    const commit = env.ZEABUR_GIT_COMMIT_SHA || env.GIT_COMMIT || "";
    resource.buildCommit = /^[a-f0-9]{7,64}$/.test(commit) && !/[\r\n]/.test(commit) ? commit : null;
    return {
        configInvalid: Object.entries(config).some(
            ([key, value]) => value !== undefined && !token(value, key === "instanceId" ? 128 : 64)
        ),
        resource: Object.freeze(resource),
    };
}

module.exports = { create, fromEnvironment, token };
