// Instant start on a slow machine: read aloud in the system voice straight away, generate the
// natural voice in the background, and change over once there is enough audio to keep going.
//
// This engine owns no playback of its own. It drives the two real engines and presents the same
// { start, pause, resume, stop } shape as either, so main.js treats it as a third choice.
//
//   t=0     system voice starts speaking; the player begins generating, muted
//   t=...   each system sentence is reported to the player, so it knows where we are
//   ready   the player has enough audio from the next paragraph break onwards
//           -> stop the system voice, hand playback to the natural one
//
// On a machine that can carry the natural voice unaided, the player declines the lead-in before
// the system voice is audible (see needsLeadIn in src/offscreen/player.js) and we go straight to
// the natural voice. The listener hears one voice, not two.

const GRACE_MS = 350; // how long to let the player decline the lead-in before we start speaking

// Said once per service-worker lifetime, not once per handover: seeking starts a fresh session
// and nobody wants to be told the same thing on every jump.
let toldAboutSwitch = false;

export function createHybridEngine(emit, { system, neural, tap }) {
  let s = null;

  async function start(sentences, from, settings, { blockStarts = [] } = {}) {
    stop();
    const mine = (s = {
      sentences, blockStarts, settings,
      index: from, handed: false, leadIn: false, offs: [], warned: false, leadInTimer: null, paused: false
    });

    // Follow the system voice so the player always knows where it has reached.
    mine.offs.push(tap((who, type, data) => {
      if (s !== mine || mine.handed || who !== 'system') return;
      if (type === 'sentence') {
        mine.index = data.index;
        neural.at(data.index);
      } else if (type === 'state' && (data.state === 'ended' || data.state === 'error')) {
        // The system voice reached the end before the natural one was ready. Nothing left to
        // hand over, so stop generating rather than burning CPU on audio nobody will hear.
        mine.handed = true;
        neural.stop();
      }
    }));

    // The player tells us when it can take over, or that it never needed us.
    mine.offs.push(neural.listen((ev, data) => {
      if (s !== mine || mine.handed) return;
      if (ev === 'ready') handOver(mine, data.from, data.immediate);
      else if (ev === 'prime') noteDownload(mine, data);
    }));

    // Start generating first, then give the player a moment to say the lead-in is unnecessary.
    await neural.start(sentences, from, settings, { prime: true, blockStarts });
    if (s !== mine || mine.handed) return;
    armLeadIn(mine);
  }

  /**
   * Start the system voice unless the player declines first. Pausing inside the grace window
   * disarms this — otherwise the system voice would start talking a third of a second after the
   * listener pressed pause.
   */
  function armLeadIn(mine) {
    clearTimeout(mine.leadInTimer);
    mine.leadInTimer = setTimeout(() => {
      if (s !== mine || mine.handed || mine.paused) return;
      mine.leadIn = true;
      system.start(mine.sentences, mine.index, mine.settings);
    }, GRACE_MS);
  }

  function handOver(mine, from, immediate) {
    clearTimeout(mine.leadInTimer);
    mine.handed = true;
    if (mine.leadIn) {
      system.stop();
      emit('state', { state: 'buffering', detail: 'Switching to the natural voice' });
      // The voice just changed mid-article. Some people will prefer to wait instead, and this is
      // the only place that offer makes sense — but say it once, not on every seek.
      if (!toldAboutSwitch) {
        toldAboutSwitch = true;
        emit('hint', { text: 'Switched to the natural voice.', action: 'Always wait for it instead', actionId: 'nohandoff' });
      }
    }
    neural.begin(immediate ? from : Math.max(from, mine.index + 1));
  }

  /** First run downloads ~90 MB. Say so once, since the voice will change when it finishes. */
  function noteDownload(mine, { progress }) {
    if (mine.warned || !mine.leadIn || progress == null || progress >= 0.99) return;
    mine.warned = true;
    emit('hint', {
      text: 'The natural voice is downloading in the background. You are hearing your system voice until it is ready.',
      action: 'Got it',
      actionId: 'dismiss'
    });
  }

  // Whoever is actually making sound: the natural voice once we have handed over, the system
  // voice during the lead-in, and the natural one before the lead-in begins.
  const active = () => (s?.handed ? neural : s?.leadIn ? system : neural);

  function stop() {
    if (s) {
      clearTimeout(s.leadInTimer);
      for (const off of s.offs) off();
      s = null;
    }
    system.stop();
    neural.stop();
  }

  return {
    start,
    pause() {
      if (s) { s.paused = true; clearTimeout(s.leadInTimer); }
      active()?.pause();
    },
    resume(restartFrom) {
      if (s) s.paused = false;
      // Paused before either voice got going: re-arm the lead-in rather than sitting silent.
      if (s && !s.handed && !s.leadIn) return armLeadIn(s);
      active()?.resume(restartFrom);
    },
    rate(speed) { neural.rate(speed); },
    // Both sides need it: the system voice may be reading aloud while the natural one generates.
    extend(sentences, blockStarts) {
      if (s) s.sentences = sentences;
      system.extend?.(sentences);
      neural.extend(sentences, blockStarts);
    },
    stop
  };
}
