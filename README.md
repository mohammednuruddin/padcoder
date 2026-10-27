<img src="docs/icon.png" width="128" alt="PadCoder icon">

# PadCoder 🎮

Vibe code with a game controller. PadCoder turns a PS5 DualSense or PS4 DualShock 4
(Xbox pads work too) into a keyboard and mouse built for driving
[Claude Code](https://claude.com/claude-code) in the Claude desktop app, or any other Mac app.

- **Buttons for the common moves:** send, stop, dictate, accept, undo and paste, plus quick prompts and a prompt wheel.
- **Approve from the pad:** answer Claude's permission requests with ✕ / ○ after reading the exact command on screen.
- **Status you can feel:** the light bar shows what Claude is doing, and the pad buzzes when Claude finishes or needs you.
- **A live settings window:** a drawing of your controller that lights up as you press. Click any button to remap it.

![PadCoder window](docs/window.png)

## Requirements
- macOS 13 or later
- Xcode or the Xcode Command Line Tools (for `swiftc`)
- A DualSense or DualShock 4 paired over Bluetooth or USB

## Install
```bash
git clone https://github.com/mohammednuruddin/padcoder.git
cd padcoder
./build.sh install
open /Applications/PadCoder.app
```
Then turn on **PadCoder** in System Settings → Privacy & Security → **Accessibility**, so it can type and click.
It adds itself as a login item, shows a 🎮 in the menu bar, and opens its window the first time.

`build.sh` signs the app with your Apple Development certificate if you have one, so the
Accessibility permission survives rebuilds. Otherwise it signs ad hoc, and you'll need to turn
Accessibility off and on again after each rebuild.

## The PadCoder window
Open it from 🎮 → **Open PadCoder…**, or open the app again from Spotlight.
- **Buttons**: a live drawing of your controller. It shows a DualSense for PS5 and a DualShock 4 for PS4, in white or black.
  - Buttons light up as you press them. The sticks, triggers, touchpad and light bar move live.
  - Click any part to change what it does, or use **Record** to capture a shortcut.
  - Test buttons for rumble, the light bar, and L2/R2 trigger force (DualSense only).
- **Prompt Wheel**: the 8 wheel prompts and the 4 quick prompts.
- **Tuning**: what each stick does (move the mouse, scroll, or off), stick, scroll, touchpad and gyro speeds, and the invert switches.
- **Approvals**: approve from the pad on/off, and how long to wait.

While the window is in front, the controller only lights things up there. It won't type or click.

## Default buttons

| Button | Does |
|---|---|
| ✕ Cross | **Return**: send / confirm |
| ○ Circle | **Esc**: stop Claude / cancel |
| □ Square | **Backspace** (hold to repeat) |
| △ Triangle | **Cmd+D**: Claude's dictation |
| Options ≡ | **Cmd+Return**: accept a suggested task / submit a dialog |
| D-pad | Arrow keys (hold to repeat) |
| Left stick | Move the mouse. Each stick can be set to move the mouse, scroll, or off. |
| Right stick | Scroll |
| R1 (hold) | **Gyro aim**: tilt the pad to fine-move the mouse |
| R2 / L2 | Left click (hold to drag) / right click |
| L3 / R3 (press sticks) | Cmd+Z undo / Cmd+V paste |
| Create / Share | **Pause / resume** PadCoder (the light bar dims, so you can game) |
| Touchpad | 1 finger moves the mouse · press = click · 2 fingers scroll · quick 2-finger swipe ← / → = previous / next tab |

### Hold L1 for the second layer
| Combo | Does |
|---|---|
| L1 + ✕ / ○ / □ / △ | Quick prompts, such as "yes, go ahead" and "run it and fix any errors" |
| **L1 + L2** | **Model menu** (⌘⇧I) |
| **L1 + R2** | **Reasoning effort menu** (⌘⇧E) |
| L1 + Create / Share | Permission mode menu (⌘⇧M) |
| L1 + Options | Cmd+N |
| **L1 + Touchpad** | **Play Bug Dash** (press again to go back to Claude) |
| L1 + R1 | Shift+Tab |
| L1 + D-pad | Page Up / Page Down / Home / End |
| **L1 + right stick** | **Prompt wheel**: point at one of 8 prompts and release L1 to send. Center the stick first to cancel. |

To switch model or effort, open the menu with L1 + L2 or L1 + R2, release L1, pick with the D-pad,
and press ✕. ○ closes the menu. These are the Claude desktop app's own shortcuts. The shortcut editor
lists them under **✦ Claude**, so you can put them on any button.

## Light bar = what Claude is doing
| Color | Meaning |
|---|---|
| Orange | Idle |
| Pulsing blue | Working |
| Green flash + 1 buzz | Finished a reply |
| Pulsing red + 3 buzzes | Needs your approval. R2 also gets a "click" resistance (DualSense only) |
| Dim | PadCoder is paused |

## Bug Dash: play while Claude works
![Bug Dash](docs/bugdash.png)

An endless runner that lives in Claude Code itself: a mod drawn in the band above the prompt, where
pets live. Clawd runs through a city of code at dusk, jumping bugs, sliding under failing tests and
grabbing ✦ tokens.

- **L1 + Touchpad** shows it and turns the pad into its controller. Press it again to drive Claude.
  `/bugdash` shows or hides it too, and hiding it gives the pad back to Claude.
- **✕** or the touchpad jumps (press again in the air to double-jump) · **○** slides under a FAIL banner
  (in the air it dives) · **□ / R1 / R2** dash through anything, using one of three charges ·
  **Options** pauses. No pad? Click **Play** on the band, then use w, s, d and p.
- A token is 25 points, clearing a bug or a banner 10, and smashing a bug mid-dash 15. Your best is kept.
- Every 9 seconds is a new level. The world speeds up and the long gaps close in, and combos come in
  as you go: a bug then a banner from level 4, a banner then a bug from level 6, three bugs from level 9
  and two banners from level 12. Points count double from level 5, triple from level 9 and so on. It
  stops getting harder at level 41, six minutes in.
- When Claude **finishes** or **needs your approval**, the run pauses and says why, and the pad goes
  straight back to Claude. Resuming counts down 3, 2, 1 first. The pad rumbles when Clawd is caught.
- In game mode the pad sends notifications (`com.padcoder.game.jump` and so on), not keystrokes, so
  nothing is typed into Claude by accident.
- It is cheap to run. The mod redraws only when something happens, such as an obstacle reaching Clawd
  or a point scored, and CSS animation moves the scene in between. Paused or hidden, it costs nothing.

### The daily race
Everyone runs the same course each day (UTC), and you can race it online:

- `/bugdash join <name>` takes a name. From then on, each run is sent when Clawd is caught. The race
  server plays it again from your moves with the game's own rules, so a score has to be one those moves
  really make on the course, and keeps your best of the day. A copy of one of the day's top runs by
  another player, even nudged a few milliseconds or padded with more moves, is refused.
- The ready card shows who leads today and where you stand; the game-over card shows your rank.
- Two ghosts run with you: the day's leader and your own best, pale Clawds just behind yours, with
  their names and scores on the ground beneath.
- `/bugdash top` lists today's top ten. `/bugdash leave` stops sending runs; your name stays taken.
- What is sent, to `bug-dash.nurusterling.workers.dev`: your name, and each run's moves and score.
  Nothing about Claude or your work. Until you join, the mod sends nothing, except the request for the
  board when you run `/bugdash top`.

### Install Bug Dash
At the prompt of a Claude Code terminal session:

```
/plugin install bug-dash --marketplace mohammednuruddin/padcoder
```

Answer `y` to add the marketplace, then press Enter to install for your user. From a shell, run
`claude plugin marketplace add mohammednuruddin/padcoder`, then `claude plugin install bug-dash@padcoder`.
In the desktop app, click **+** next to the prompt box, then **Plugins**, add the marketplace
`mohammednuruddin/padcoder`, and add **bug-dash**. Once installed, it loads in every session, the
desktop app included.

The game draws in the desktop app; a terminal has no SVG, so there the band is left as it was. Every
open session runs its own copy, so L1 + Touchpad starts the game in each of them: keep one Claude window
open while you play. Hiding the game the pad plays hands the pad back to Claude in all of them; one
shown with `/bugdash` alone leaves the pad as it was. The mod's source is in [`mods/bug-dash`](mods/bug-dash).

## Power use
PadCoder is built to cost nothing while you aren't using it:
- The input loop runs only while a stick is pushed, a key repeats, gyro aims or the wheel is open.
- Config and approval files are watched, not polled.
- The light bar is set once per state change. Only "needs you" pulses.
- The settings window redraws only when an input changes.
- The rumble motors' engine powers down between rumbles.

With the window closed and no controller input, `top` measures 0% CPU and 0 wake-ups a second
(it was about 350 a second before this work). With the window open and idle, it's under 1 a second.

## Connect it to Claude Code
The status light, buzzes and pad approvals come from Claude Code
[hooks](https://code.claude.com/docs/en/hooks). Add this to `~/.claude/settings.json`,
merging it with any `hooks` you already have:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "notifyutil -p com.padcoder.working 2>/dev/null || true", "async": true }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "notifyutil -p com.padcoder.working 2>/dev/null || true", "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "notifyutil -p com.padcoder.buzz 2>/dev/null || true", "async": true }] }
    ],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "\"$HOME/Library/Application Support/PadCoder/permission-hook.sh\"", "timeout": 90 }] }
    ]
  }
}
```

`./build.sh install` puts `permission-hook.sh` in place.

### Approving from the pad
When Claude asks permission, a panel at the top of the screen shows the tool and the exact
command or file. Press **✕ to approve**, **○ to deny**, or **△ to leave it to Claude's normal dialog**.
In the Claude desktop app, the dialog stays usable at the same time and whichever you answer first wins.
In terminal Claude Code, the prompt can wait up to the approval timeout (20 s by default) while a pad is connected.
△ skips the wait, and you can turn approvals off on the Approvals page.

The hook only waits for the pad while PadCoder is running, a controller is connected and PadCoder isn't paused.
Otherwise it exits at once and Claude shows its normal dialog.

## Config file
Everything the window edits lives in `~/Library/Application Support/PadCoder/config.json`
(🎮 → Edit Config File…). Changes apply on save.

Actions:
- a key combo: `"return"`, `"cmd+d"`, `"cmd+return"`, `"ctrl+shift+tab"`
- `"send:text"` types the text and presses Return; `"type:text"` types it without Return
- `"leftClick"`, `"rightClick"`, `"gyro"`, `"pause"`, `"dictation"` (macOS dictation), `"none"`
- in `l1Layer`, `""` means "same as the normal press"

`leftStick` and `rightStick` set what moving each stick does: `"mouse"`, `"scroll"` or `"off"`.

## Development
- `./build.sh` builds `PadCoder.app` in the repo.
- `./build.sh install` also replaces `/Applications/PadCoder.app` and the hook script, and quits the running copy.
  Run `open /Applications/PadCoder.app` afterwards.
- `PadCoder.app/Contents/MacOS/PadCoder --snapshot <dir>` renders the window and HUDs to PNGs, for checking layout.
- `claude plugin test mods/bug-dash` runs the mod's tests, including a bot that plays seven minutes of the course
  and checks that every run replays exactly from its moves.
  `claude --plugin-dir mods/bug-dash` runs the mod from your checkout, reloading as you edit it.
- `server/` is the daily race's server: a Cloudflare Worker with a D1 database. It imports the mod's own
  `scene.ts` to replay runs. To run it locally, from `server/`:
  `npx wrangler@4.140.0 d1 execute bug-dash --local --file schema.sql`, then `npx wrangler@4.140.0 dev --local`.
  `BUG_DASH_SERVER=http://127.0.0.1:8787 claude --plugin-dir mods/bug-dash` points the mod at it.
  To host your own: `npx wrangler login`, `npx wrangler d1 create bug-dash` (its id goes in `wrangler.toml`),
  `npx wrangler d1 execute bug-dash --remote --file schema.sql`, then `npx wrangler deploy`.

| File | What's in it |
|---|---|
| `Sources/PadCoder.swift` | Controller input, actions, light bar, triggers, approvals |
| `Sources/Events.swift` | Posting keyboard and mouse events |
| `Sources/Config.swift` | Defaults and the hot-reloaded config file |
| `Sources/ControllerView.swift` | Vector DualSense / DualShock 4 drawings |
| `Sources/SettingsView.swift` | The PadCoder window |
| `Sources/Overlay.swift` | Prompt wheel and approval HUD |
| `hooks/permission-hook.sh` | The Claude Code `PermissionRequest` hook |
| `mods/bug-dash/hooks/scene.ts` | Bug Dash's rules and its SVG scene |
| `mods/bug-dash/hooks/register.tsx` | The mod's hooks: the band, `/bugdash`, the pad's signals, the race's requests |
| `mods/bug-dash/hooks/race.ts` | What goes to the race server and how its answers are read |
| `server/src/index.ts` | The race server: joining, the daily board and ghosts, replaying runs |

## Troubleshooting
The log is at `~/Library/Logs/PadCoder.log` (🎮 → Open Log). It records button presses,
state changes, wheel picks, approvals and config saves.
- **Nothing types or clicks:** check Accessibility for PadCoder, then quit and reopen it.
- **Gyro or scroll goes the wrong way:** use the Tuning page.

## Notes
The controller drawings are original vector art. PlayStation, DualSense and DualShock are
trademarks of Sony Interactive Entertainment. Claude is a trademark of Anthropic.
This project is not affiliated with either company.

## License
[MIT](LICENSE)
