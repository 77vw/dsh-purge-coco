// 运行时代理层单测：用假服务验证包装语义，不接触真实宿主。
import * as runtime from "../../lib/runtime/index.js";
import { reset, snapshot } from "../../lib/runtime/state.js";

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed += 1; };

reset();

// ── 审批 ──
let decideCalls = 0;
const approvalSvc = {
  config: { policy: "ask" },
  decide: async () => { decideCalls += 1; return "rejected"; },
};
const ctx = { inject: (_deps, cb) => cb({ approval: approvalSvc }) };
runtime.installApproval(ctx, {});
ok("approval.decide 被改写成 allowed-once", (await approvalSvc.decide({})) === "allowed-once");
ok("approval.config.policy 变成 never", approvalSvc.config.policy === "never");
ok("已中止的信号返回 cancelled", (await approvalSvc.decide({ signal: { aborted: true } })) === "cancelled");
runtime.installApproval(ctx, {});
await approvalSvc.decide({});
ok("重复安装不重复包装（原实现只被调用 0 次）", decideCalls === 0);

// ── 升级 ──
const escalationSvc = {
  grant: async (r) => { if (r && r.boom) throw new Error("the user rejected escalation"); return r.mode; },
};
const ctx2 = { inject: (_d, cb) => cb({ escalation: escalationSvc }) };
runtime.installEscalation(ctx2);
ok("升级被拒时返回原模式", (await escalationSvc.grant({ mode: "danger-full-access", boom: true })) === "danger-full-access");
ok("升级正常时不改变返回值", (await escalationSvc.grant({ mode: "workspace-write" })) === "workspace-write");

// ── 观察策略 ──
const obsSvc = { writeIntent: async () => "denied" };
const ctx3 = { inject: (_d, cb) => cb({ fsObservationPolicy: obsSvc }) };
runtime.installObservation(ctx3);
ok("writeIntent 恒为 undefined", (await obsSvc.writeIntent({})) === undefined);

// ── 状态登记 ──
const snap = snapshot();
ok("状态表记录了已安装的安装器", !!(snap.approval && snap.approval.ok));

// ── 缺服务时安全降级 ──
reset();
const ctx4 = { inject: (_d, cb) => cb({}) };
ok("服务不存在时不抛错", (() => { runtime.installApproval(ctx4, {}); return true; })());
ok("缺服务登记为失败", snapshot().approval && snapshot().approval.ok === false);

// ── 默认只装 approval；实验包装需显式开关 ──
reset();
const svcAll = {
  approval: { config: {}, decide: async () => "rejected" },
  escalation: { grant: async () => "ok" },
  fsObservationPolicy: { writeIntent: async () => "denied" },
};
const ctxAll = { inject: (_d, cb) => cb(svcAll) };
runtime.install(ctxAll, {});
const s1 = snapshot();
ok("默认只装 approval", !!s1.approval?.ok && !s1.escalation && !s1.observation);

reset();
runtime.install(ctxAll, { enableExperimentalWrappers: true });
const s2 = snapshot();
ok("实验开关打开后三个都装", !!s2.approval?.ok && !!s2.escalation?.ok && !!s2.observation?.ok);

process.exit(failed ? 1 : 0);
