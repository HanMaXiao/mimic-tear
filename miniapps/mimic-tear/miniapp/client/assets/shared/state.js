/**
 * 页面状态。
 *
 * 整个看板只有一份状态：视图模块读它、运行时模块写它，所以它住在共享层里，
 * 由各处 `import` 同一份对象（不是各写各的副本）。
 */

export const state = {
  overview: null,
  inbox: [],
  skills: null,
  // The reusable-skill registry: what the boss packaged from real work, as opposed to
  // the capability scan above, which is only what happens to be installed on the machine.
  skillLibrary: null,
  project: null,
  projectId: null,
  domain: null,
  filterProject: '',
  filterKind: '',
  pendingOnly: true,
  loading: false,
  error: null,
  // The route currently on screen. The header names the section, so the client has to
  // know where it is without re-reading the URL on every repaint.
  view: 'chat',
  // The board's last word on the duty boss. The lamp in the header is driven by it.
  duty: null,
  // The project and session the dispatch dialog is currently aimed at. The dialog must
  // remember its own target: deriving it from the current route silently sends the
  // instruction to whichever project was opened last.
  dispatchTarget: { projectId: null, sessionId: null },
  // The dispatch this page is waiting for. The dispatch itself lives on the server; the
  // page only remembers its id, so a reload can read the record back instead of losing
  // an instruction that is still on its way.
  dispatchId: null,
  dispatch: null,
  // The dispatches already announced on this page, so a restored outcome and a live
  // event never say the same thing twice.
  announcedDispatches: new Set(),
  // The watchdog's alert log. `null` means "not read yet" — the panel is still loading.
  alerts: null,
  alertsError: null,
  // The conversation with the boss. `messages` is the transcript; `streaming` is the reply
  // being written right now; `question` is the questionnaire the boss is waiting on.
  // `bossSessionId` is the boss's own session, needed to open the same conversation in the
  // Host's chat side panel.
  //
  // `transcript` is the authoritative list, read back from the runtime session. The Host
  // chat side panel writes to the same session, so the transcript is what keeps the two
  // views in step — and what makes the conversation survive a page reload.
  chat: {
    messages: [],
    streaming: null,
    tools: [],
    question: null,
    answers: {},
    bossSessionId: null,
    duty: [],
    transcript: [],
  },
};
