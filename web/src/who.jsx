// Who did it (an agent or a person) and an intent's priority, as the board, change detail and threads show them.
import { Ic } from "./icons.jsx";
import { Dot } from "./ui.jsx";

const PRI = { P0: "bad", P1: "warn", P2: "info", P3: "" };
// Agents are name@version (3.3.0, v3) or name@channel; people are a name or an email (a domain after the @).
export const isAgent = (a) => /@([^.]+|v?\d[\d.]*)$/.test(a);
export const Who = ({ a }) => <span className="who">{isAgent(a) ? <Ic name="robot" /> : <span className="av">{a[0].toUpperCase()}</span>}<span className={isAgent(a) ? "mono" : undefined}>{a}</span></span>;
// A change's author: agent@version, or the person.
export const ChangeWho = ({ change }) => <span className="mono">{change.ver ? `${change.agent}@${change.ver}` : `${change.agent} · person`}</span>;
export const Pri = ({ p }) => (p ? <span className="pill"><Dot tone={PRI[p]} />{p}</span> : null);
