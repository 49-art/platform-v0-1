import { Link } from "react-router";
import { InstallButton } from "../../components/ui";
import { useSession } from "../../lib/session";

/** The first screen. Opens on the product's one promise: two verified people, then a date. */
export default function Welcome() {
  const { me } = useSession();
  return (
    <div className="welcome">
      <div className="ring-row" aria-hidden="true">
        <span className="face verified"><span style={{ display: "block", width: "100%", height: "100%", borderRadius: "50%", background: "radial-gradient(circle at 40% 35%, #ff7cc4, #7a1a8f 70%)" }} /></span>
        <span className="handshake" />
        <span className="face verified"><span style={{ display: "block", width: "100%", height: "100%", borderRadius: "50%", background: "radial-gradient(circle at 60% 35%, #8ff8ff, #23307a 70%)" }} /></span>
      </div>
      <h1>Both of you verified. Then dinner.</h1>
      <p className="lede">A free dating app for adults who want to meet a real person. No bots, no paid profiles. Before you can plan a date, you both prove who you are.</p>
      <div className="row">
        {me?.user ? (
          <Link className="btn" to="/app">Open the app</Link>
        ) : (
          <>
            <Link className="btn" to="/signup">Join free</Link>
            <Link className="btn ghost" to="/login">Sign in</Link>
          </>
        )}
        <InstallButton className="btn ghost" />
      </div>
      <div className="promise">
        <section className="panel tone-cyan">
          <h3>Real people only</h3>
          <p>Every profile and photo is checked by a person before anyone sees it. Anything that looks like a bot can be reported in one tap.</p>
        </section>
        <section className="panel tone-pink">
          <h3>Verify before you meet</h3>
          <p>Chat once you match. Date planning, number swaps and links unlock only when you are both ID-verified.</p>
        </section>
        <section className="panel tone-amber">
          <h3>A plan someone knows about</h3>
          <p>Share your date with a trusted contact, set a check-in time, and keep an SOS button in reach.</p>
        </section>
      </div>
      <p className="small muted">18+ only. Free to use. UK launch.</p>
    </div>
  );
}
