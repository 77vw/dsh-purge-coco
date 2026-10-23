// 宿主面适配：web / desktop / gui / tui 的判定与适配器契约
import { detectSurface, adapterFor, SURFACES } from "../../lib/engine/surface.js";
import { hostAdapter, currentSurface, restartNote } from "../../lib/engine/host.js";

let failed = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!c) failed += 1; };

ok("四种面已声明", SURFACES.join(",") === "web,desktop,gui,tui");

ok("默认判为 web", detectSurface({ env: {} }) === "web");
ok("DSH_SURFACE 可强制指定面", detectSurface({ env: { DSH_SURFACE: "desktop" } }) === "desktop");
ok("非法 DSH_SURFACE 被忽略", detectSurface({ env: { DSH_SURFACE: "nope" } }) === "web");

ok("gui 走 web 适配器", adapterFor("gui") === "web");
ok("tui 走 web 适配器", adapterFor("tui") === "web");
ok("desktop 走 desktop 适配器", adapterFor("desktop") === "desktop");

const web = hostAdapter("web");
const desk = hostAdapter("desktop");
ok("web 适配器有 scheduleRestart", typeof web.scheduleRestart === "function");
ok("desktop 适配器有 scheduleRestart", typeof desk.scheduleRestart === "function");
ok("currentSurface 返回合法值", SURFACES.includes(currentSurface()));
ok("restartNote 返回字符串", typeof restartNote() === "string");

process.exit(failed ? 1 : 0);
