# D. Presence and activity: how other apps do it, why Capy's cursors glitch, what an activity panel needs

Prepared 2026-11-01 on branch `blocksuite-notes` (f2ad7b79f), read-only. I ran no builds, tests or
servers; everything below comes from reading code, docs and public pages. Paths are relative to the
worktree `/Users/sam/web/capy-notebook/.claude/worktrees/blocksuite-notes`. Every web claim has a URL.
"(unverified)" marks a claim that rests on memory, a search-engine summary or one weak source. The
web research ran out of search quota part-way, so some help-centre pages were read directly and a
few (Kahoot, Discord) only through search summaries of the official articles.

---

## 0. Summary

**Comparison.**
- Every editor has the same base: an avatar stack, named cursors and selection outlines.
- They differ on four things:
  - **Idle.**
    - tldraw: idle after 3 s, hidden after 60 s inactive.
    - Excalidraw: idle after 60 s, "away" when the tab is hidden, drawn at 30% opacity.
    - Slack: away after 10 min.
    - AFFiNE and Capy have no idle state; y-protocols simply drops a peer after 30 s.
  - **Follow.**
    - Personal follow that ends on your own input: tldraw, Excalidraw, Google Slides.
    - Broadcast spotlight with a "Not now": Figma; "Bring everyone to me": Miro.
    - Host-paced vs self-paced: the quiz apps.
  - **History.** It is always a separate surface from live presence, and usually has opt-outs: Google
    Docs view history, Notion analytics, Linear feeds, Strava and Duolingo feeds.
  - **Privacy.**
    - Editors offer little beyond "hide others' cursors"; Google Slides is the exception (your own
      pointer is off by default).
    - Social apps give per-space and per-item switches: Discord's per-server activity sharing,
      Strava's per-activity visibility and under-18 defaults.
- For quizzes, peers see standing (a top 5, "7 of 20") and only the host sees answers: Kahoot,
  Wayground, Mentimeter.

**Diagnosis, ranked.** These are the most likely causes of carets, pointers and block outlines that
glitch or vanish in Plate notes and Office files:
1. A tab hidden for 5+ minutes stops renewing its presence, because Chrome then runs timers once a
   minute. Co-editors drop it after 30 s and get it back at the next renewal, so its caret blinks.
2. After any rejoin the server saw coming, the rejoined tab's state is ignored for up to two
   awareness changes. That is ~30–36 s when the user is idle. The rejoining tab also misses idle
   peers for up to ~18 s. This is documented as accepted.
3. The mouse pointer is cleared by *any* scroll anywhere in the page (chat streaming, the file tree)
   and by window blur, so it flickers.
4. Re-renders caused by remote presence snap the *local* caret back after native caret moves. An
   existing e2e works around this.
5. By design, a block selection removes the caret, voids and embeds show no caret, and carets have
   no name flag. To a user these look like disappearance.
6. A rejoining user gets a new per-room person number, so their colour changes; labels also lag
   joins by up to 1 s.
7. The overlay is not re-placed on nested scrolls or animations, so outlines drift.

On this branch, BlockSuite notes show no remote presence at all:
- the widget is off;
- the server drops every `selectionV2` state;
- a remote state without `selectionV2` throws inside BlockSuite's selection extension, which can
  lose the rest of a frame, ACK included.

**Activity panel.**
- **What exists today:**
  - per-room awareness and presence (editors only);
  - a per-user SSE stream;
  - workspace `ingest`/`tree` events that name no actor and reach link visitors too;
  - owner-only chat runs;
  - private study tables;
  - hidden attribution columns.
- **Three architectures:**
  - **A.** Client-reported fields in the workspace canvas room's awareness. Cheapest; nothing is
    stored, and privacy comes from self-report.
  - **B.** A server-derived workspace hub in collaboration-rs. Truthful, but it is new server code
    and tied to one instance.
  - **C.** Gateway SSE events from the producers that already know the actor, optionally with a
    stored feed. Covers server-side jobs, but it has the highest privacy cost and needs Epo's
    sign-off.

---

## 1. How other apps show presence and activity

### 1.1 Canvas and editor apps

**Figma (Design files)**
- *Where:*
  - Avatars sit in the file toolbar, and cursors carry name labels
    ([view options](https://help.figma.com/hc/en-us/articles/360041065034),
    [spotlight](https://help.figma.com/hc/en-us/articles/360040322673)).
  - The file browser guide covers Recents and the bell, but not who is in a file now
    ([file browser](https://help.figma.com/hc/en-us/articles/14381406380183)).
- *States:*
  - No idle or away state is documented.
  - A presenter's avatar gets a dashed border and a follower count ([spotlight](https://help.figma.com/hc/en-us/articles/360040322673)).
  - In audio calls, speakers move up and their cursors pulse. After a long silence Figma asks if
    you are still there, then disconnects you ([audio](https://help.figma.com/hc/en-us/articles/1500004414622)).
- *Follow:*
  - Click an avatar to follow. In 2018 this was called "observation mode" and worked for view-only
    users too ([blog](https://www.figma.com/blog/figma-feature-highlight-observation-mode/)).
  - "Spotlight me" moves everyone to your view after a few seconds unless they pick "Not now".
    "Ask to spotlight" can be declined.
  - The person followed is not told who follows them ([spotlight](https://help.figma.com/hc/en-us/articles/360040322673)).
- *Live vs past:*
  - Version history autosaves every 30 min ([versions](https://help.figma.com/hc/en-us/articles/360038006754)).
  - Profiles list files a person edited or commented on ([profiles](https://help.figma.com/hc/en-us/articles/360039957614)).
  - Admin activity logs record "viewed a file" on Organization, Enterprise, K-12 and Government
    plans ([activity logs](https://help.figma.com/hc/en-us/articles/360040449533)).
- *Notifications:* mentions and invites go to the bell; spotlight prompts appear in the file.
- *Privacy:*
  - You can hide others' cursors with ⌥⌘\ ([view options](https://help.figma.com/hc/en-us/articles/360041065034)).
  - Users ask for a way to hide their own cursor or refuse being followed (unverified,
    [forum](https://forum.figma.com/suggest-a-feature-11/disable-observe-mode-18772/index2.html)).
  - Some plans' admins can turn off cursor chat, and its messages are never logged
    ([admin](https://help.figma.com/hc/en-us/articles/14564080039447)).

**FigJam**
- Avatars sit in the right sidebar; clicking one follows that person. Anyone can take the spotlight
  ([FigJam spotlight](https://help.figma.com/hc/en-us/articles/5025214483351)).
- Cursor chat opens with "/" and stays 5 s after you stop typing ([cursor chat](https://help.figma.com/hc/en-us/articles/1500004414842)).
- Stamps and high fives fade ([stamps](https://help.figma.com/hc/en-us/articles/1500004290981)).
- Open sessions give visitors a nickname for 24 h ([open sessions](https://help.figma.com/hc/en-us/articles/4410786053911)).
- Mentions send an email and an in-app notice ([mentions](https://help.figma.com/hc/en-us/articles/14994886863383)).
- Timer, music and voting ([explore](https://help.figma.com/hc/en-us/articles/15300412458647)).

**Miro**
- *Where:*
  - Live cursors, and you can see when teammates are online ([async](https://miro.com/workshops-async-collaboration/)).
  - The SDK's list of online users gives only an id and a name ([SDK](https://developers.miro.com/docs/websdk-reference-board)).
  - A facepile with an overflow count (unverified).
- *Follow:*
  - Facilitators have "Bring Everyone to Me" ([education](https://miro.com/education-whiteboard/)).
  - An experimental SDK call makes chosen users follow someone ([attention SDK](https://developers.miro.com/docs/websdk-reference-attention)).
- *Privacy:*
  - Private mode lets each person write anonymously ([meetings](https://miro.com/meetings-and-workshops/)).
  - Students can join without registering ([education](https://miro.com/education-whiteboard/)).
  - Hiding cursors, idle states, version history and digests are all unverified (help.miro.com
    returned 403).

**tldraw**
- *Where:*
  - The people menu shows the last 5 people (1 on the smallest phones), then a count
    ([FacePile](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/ui/components/SharePanel/DefaultPeopleMenuFacePile.tsx)).
  - Each row zooms to that person or follows them, and an icon marks "Following you"
    ([MenuItem](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/ui/components/SharePanel/DefaultPeopleMenuItem.tsx)).
  - Cursors show a name and a chat bubble; people off screen show as edge arrows ([cursors](https://tldraw.dev/sdk-features/cursors)).
- *States:*
  - Active, then idle after 3 s, then inactive after 60 s of no activity, checked every 1.2 s.
    Inactive people are hidden unless you follow them.
  - Several tabs of one user collapse to the newest
    ([CollaboratorsManager](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/editor/managers/CollaboratorsManager/CollaboratorsManager.ts),
    [options](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/options.ts)).
- *Follow:*
  - The camera eases to the other person's view, crossing pages with them.
  - It ends on your own input, a page change of your own, or the other person leaving
    ([following](https://tldraw.dev/sdk-features/user-following)).
- *Data model and rate:*
  - Presence holds the camera, screen bounds, cursor, `selectedShapeIds`, `followingUserId`,
    `chatMessage` and `lastActivityTimestamp`
    ([TLPresence.ts](https://github.com/tldraw/tldraw/blob/main/packages/tlschema/src/records/TLPresence.ts)).
  - It is sent 30 times a second while others are present, and not at all when you are alone
    ([useSync.ts](https://github.com/tldraw/tldraw/blob/main/packages/sync/src/useSync.ts)).
  - Presence is wiped on disconnect ([TLSyncClient](https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncClient.ts)).
- *Privacy:* only in code: a developer can hide a user or leave out their camera
  ([collaboration](https://tldraw.dev/sdk-features/collaboration)).

**Excalidraw**
- *Where:*
  - Up to 8 avatars, then a list that gains a search box
    ([UserList](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/UserList.tsx)).
  - Others' selections are dashed outlines in their colour
    ([interactiveScene](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)).
- *States:*
  - `IDLE_THRESHOLD` is 60,000 ms and `ACTIVE_THRESHOLD` 3,000 ms, so "active" is re-sent every
    3 s. The `UserIdleState` values are active, idle and away (checked:
    [constants.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts)).
  - Away means the tab is hidden ([Collab.tsx](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)).
  - Idle, away and off-screen cursors draw at 30% opacity
    ([clients.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/clients.ts)).
- *Follow:*
  - Added December 2023; scroll, zoom or click ends it, and the person followed is not told
    ([PR 6848](https://github.com/excalidraw/excalidraw/pull/6848)).
  - Your viewport is sent only while someone follows you
    ([Collab.tsx](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)).
- *Privacy:* rooms are end-to-end encrypted, presence included
  ([Portal.tsx](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx),
  [E2E](https://plus.excalidraw.com/blog/end-to-end-encryption)).
- *Rate and colour:* at most one cursor update per 33 ms; the colour is a hash of the user id
  ([clients.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/clients.ts)).

**AFFiNE / BlockSuite** (the code vendored here)
- *Where:*
  - Text and block selections, with a caret and name
    ([doc widget](https://github.com/toeverything/AFFiNE/blob/canary/blocksuite/affine/widgets/remote-selection/src/doc/doc-remote-selection.ts)).
  - Canvas cursors and selection outlines
    ([edgeless widget](https://github.com/toeverything/AFFiNE/blob/canary/blocksuite/affine/widgets/remote-selection/src/edgeless/index.ts)).
  - The document header has no facepile
    ([header](https://github.com/toeverything/AFFiNE/blob/canary/packages/frontend/core/src/desktop/pages/workspace/detail-page/detail-page-header.tsx)).
- *States:* no idle; a peer vanishes when y-protocols' 30 s timeout runs out
  ([awareness.js](https://unpkg.com/y-protocols/awareness.js)).
- *Follow:* none found.
- *History:* document history is kept 7 days on Free and 30 on Pro ([pricing](https://affine.pro/pricing)).
- *Notifications:* per-type emails, no digest
  ([service.ts](https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/src/core/notification/service.ts)).
- *Data:*
  - Awareness holds `user`, `color` and `selectionV2`, with absolute `{blockId, index}` text
    positions (`vendor/blocksuite/framework/store/src/yjs/awareness.ts:10-14`).
  - The colour is a random one of 8, kept for the session
    (`vendor/blocksuite/affine/widgets/remote-selection/src/manager/remote-color-manager.ts:14-19`).

### 1.2 Docs, chat and work apps

**Google Docs / Drive**
- *Where:*
  - Avatars sit top right, with a count of extra people ([help](https://support.google.com/a/users/answer/9305685?hl=en)).
  - Signed-out or link viewers appear as "anonymous" animals, and one person can show up as several
    ([help](https://support.google.com/docs/answer/2494888)).
  - Drive's file list shows no live presence ([help](https://support.google.com/docs/answer/65129?hl=en)).
- *States:* only who is in the file. There is no follow; picking a person jumps you once to them
  ([help](https://support.google.com/docs/answer/6239410?hl=en)).
- *Past:*
  - The Activity dashboard shows viewers and viewer trends for work and school files
    ([help](https://support.google.com/docs/answer/7378739),
    [admin](https://knowledge.workspace.google.com/admin/drive/let-users-see-file-activity)).
  - Drive's activity panel lists edits and shares ([help](https://support.google.com/drive/answer/2409045?hl=en)).
- *Notifications:* edit emails are opt-in per document
  ([update](https://workspaceupdates.googleblog.com/2022/07/edit-notifications-for-document-content-changes.html)).
- *Privacy:*
  - "Show your view history" can be turned off for all files or per file, and views made while it
    was off never appear later.
  - Admins choose on, on within the domain, or off ([help](https://support.google.com/docs/answer/7378739)).
- *Limit:* 100 people in a file at once ([help](https://support.google.com/a/users/answer/9305685?hl=en)).

**Google Slides**
- *Pointers* (checked:
  [update](https://workspaceupdates.googleblog.com/2023/09/collaborate-more-seamlessly-with-live-pointers-google-slides.html)):
  - your own pointer is **off by default**;
  - you can hide others' pointers;
  - present mode hides them;
  - there is no admin control.
- Only editors show pointers, and pointers may stop above 20 collaborators ([help](https://support.google.com/docs/answer/13853477)).
- *Follow:*
  - The follower sees a "Following" badge.
  - It ends when you edit, comment, pick a slide or start the slideshow, or when they leave or
    refresh. Anonymous or view-only people cannot be followed ([help](https://support.google.com/docs/answer/12815819)).
  - It is on by default with no admin switch
    ([update](https://workspaceupdates.googleblog.com/2022/12/follow-collaborator-google-slides.html)).
- Presenter view has audience Q&A ([help](https://support.google.com/docs/answer/6386827)).

**Notion**
- *Where:* avatars at the top of the page, plus avatars beside any block someone has clicked or is
  editing ([help](https://www.notion.com/help/collaborate-within-a-workspace)).
- *Past:*
  - The Analytics tab shows views, unique views and each viewer's last visit
    ([guide](https://www.notion.com/help/guides/get-insights-with-page-workspace-analytics)).
  - Version history keeps 7, 30 or 90 days, unlimited on Enterprise, with a version every 10 minutes
    while editing ([help](https://www.notion.com/help/duplicate-delete-and-restore-content)).
- *Notifications:* while Notion is open you get only the badge; email goes only if it is not
  ([help](https://www.notion.com/help/comments-mentions-and-reminders),
  [settings](https://www.notion.com/help/notification-settings)).
- *Privacy:*
  - "Show my view history" in your account, or per page ([help](https://www.notion.com/help/account-settings)).
  - Owners can turn page analytics off for the workspace ([help](https://www.notion.com/help/workspace-settings)).

**Linear**
- Others' text cursors show in documents and issue descriptions
  ([docs](https://linear.app/docs/documents),
  [changelog](https://linear.app/changelog/2023-12-06-editor-improvements)).
- No viewer facepile and no online state is documented.
- *History:*
  - grouped issue activity ([changelog](https://linear.app/changelog/2025-04-03-collapsed-issue-history));
  - Pulse summaries ([changelog](https://linear.app/changelog/2025-04-16-pulse));
  - agent edits marked separately ([docs](https://linear.app/docs/documents)).
- *Notifications:* the Inbox; digests skip what you already read
  ([notifications](https://linear.app/docs/notifications.md), [inbox](https://linear.app/docs/inbox.md)).

**Slack**
- *Where:* an active/away dot plus status emoji; a huddle icon on the channel in the sidebar
  ([status](https://slack.com/intl/en-gb/help/articles/201864558-Set-your-Slack-status-and-availability),
  [huddles](https://slack.com/intl/en-gb/help/articles/4402059015315-Use-huddles-in-Slack)).
- *States:* away after 10 idle minutes on desktop, or as soon as you leave the mobile app.
- *Follow:* none. Up to two people can share their screen in a huddle, and others can draw on it.
- *Notifications:* huddle starts have their own mobile setting
  ([notifications](https://slack.com/intl/en-gb/help/articles/201355156-Configure-your-Slack-notifications)).
- *Devices:* you count as active if any device is
  ([API](https://docs.slack.dev/apis/web-api/user-presence-and-status)).

**Microsoft Teams / Loop**
- *States:* Available, Busy, In a call, Presenting, Focusing, Away, Appear offline and others.
  - Away comes after "a few minutes" idle; on mobile when the app is in the background.
  - The most recently used device decides your presence
    ([Learn](https://learn.microsoft.com/en-us/microsoftteams/presence-admins)).
  - Graph ranks sessions and fades an app to Away in two 5-minute steps
    ([Graph](https://learn.microsoft.com/en-us/graph/cloud-communications-manage-presence-state)).
- *Follow:* presenters can spotlight up to 7 videos
  ([help](https://support.microsoft.com/en-us/office/spotlight-someone-s-video-in-a-microsoft-teams-meeting-58be74a4-efac-4e89-a212-8d198182081e)).
- *Loop:* cards for who is viewing, editing or recently edited; coloured cursors; a list of
  everyone who viewed
  ([help](https://support.microsoft.com/en-us/office/first-things-to-know-about-loop-components-in-microsoft-teams-ee2a584b-5785-4dd6-8a2d-956131a29c81)).

**Discord**
- *States:* online, idle, do not disturb, invisible, offline, reported per device.
- *Activities:*
  - A verb and an item ("Playing", "Listening to", "Watching", "Competing in").
  - Rich Presence carries details, state, start/end times (shown as progress), party size and two
    buttons, updated at most 5 times per 20 s
    ([gateway](https://docs.discord.com/developers/events/gateway-events),
    [Rich Presence](https://docs.discord.com/developers/rich-presence/overview)).
- *Privacy:* "Share my activity" is a global switch, a per-server switch, and a default for new
  servers ([help](https://support.discord.com/hc/en-us/articles/7931156448919); from a search summary
  of the official article, unverified in detail).
- Go Live streams to up to 50 viewers ([blog](https://discord.com/blog/how-to-use-discord-for-your-classroom)).

### 1.3 Live quiz, study-together and friend-feed apps

**Kahoot!** (support.kahoot.com read through search extracts)
- *Where:*
  - The lobby lists nicknames on the shared screen; the host can remove one
    ([help](https://support.kahoot.com/hc/en-us/articles/115002201267)).
  - Players need only a PIN and a nickname ([trust](https://trust.kahoot.com/teachers/)).
- *Standing:* the shared screen shows only the top 5 after each question; each player sees their
  own rank on their device ([blog](https://kahoot.com/blog/2019/03/04/how-to-get-started-with-kahoot/)).
- *Pacing:* live games are teacher-paced; challenges are student-paced with a deadline
  ([ways to play](https://kahoot.com/schools/ways-to-play/)).
- *Reports:* flag difficult questions and players who need help
  ([help](https://support.kahoot.com/hc/en-us/articles/360035063054)).
- *Privacy:*
  - A nickname generator and name filter ([blog](https://kahoot.com/blog/2019/03/08/tips-keep-kahoot-nicknames-appropriate/)).
  - An optional player identifier ties nicknames to real identities ([help](https://support.kahoot.com/hc/articles/360036178314)).
  - Users under 13 (US) or under 16 (elsewhere) cannot share publicly ([help](https://support.kahoot.com/hc/articles/115001642328)).

**Wayground** (Quizizz, renamed June 2025:
[THE Journal](https://thejournal.com/Articles/2025/06/24/Quizizz-Rebrands-as-Wayground-Announces-New-AI-Features.aspx))
- *Teacher view:* "Classroom Pulse" is a teacher-only panel of who answered what, low-accuracy
  students and raised hands
  ([help](https://help.wayground.com/support/solutions/articles/158000404921-use-classroom-pulse-to-check-in-assist-students-live)).
- *Alerts:* the anti-cheating monitor flags a tab away for over 3 s
  ([help](https://help.wayground.com/support/solutions/articles/158000411388-enable-anti-cheating-monitor-previously-focus-mode-during-a-session)).
- *Pacing:* teacher-led vs student-paced
  ([modes](https://help.wayground.com/support/solutions/articles/158000404918-live-session-modes-on-wayground)).
- *Privacy:*
  - Anonymised names ([help](https://help.wayground.com/support/solutions/articles/158000404943-anonymize-student-names-previously-name-factory-)).
  - Leaderboard off, and answer feedback off, right/wrong only, or full
    ([settings](https://help.wayground.com/support/solutions/articles/158000404930-navigate-session-settings)).

**Mentimeter**
- *Presenter view:* counts of joined and responded only. Results can show at once, on click, or
  stay private ([help](https://help.mentimeter.com/en/articles/422266-hide-or-show-results)).
- *Pacing:* quizzes are always presenter-paced
  ([blog](https://mentimeter.com/blog/menti-news/live-presentation-or-survey-the-ultimate-guide-to-voting-pace)).
- *Privacy:*
  - Anonymous by default. "Names required" and "names visible to participants" are separate
    switches ([help](https://help.mentimeter.com/en/articles/10774022-choosing-participant-identity-settings-for-your-use-case)).
  - Admins can disable names for a whole workspace ([help](https://help.mentimeter.com/en/articles/10002117-gather-participant-names)).

**StudyStream**
- 24/7 Focus Rooms with live headcounts and named video tiles ([focus room](https://studystream.live/focus-room)).
- Messages on tiles; users must be 16+; "hide" (one way) is separate from "block" ([rules](https://studystream.live/rules)).
- Timers, streaks, a feed and study partners ([App Store](https://apps.apple.com/app/id6461722416)).

**Focusmate**
- *Sessions:* 1:1, 25/50/75 minutes, camera required ([FAQ](https://www.focusmate.com/faq)).
- *Accountability:* goals are declared and checked at the end
  ([help](https://support.focusmate.com/en/articles/4044432-what-happens-during-a-focusmate-session-do-s-don-ts)).
- *Privacy:*
  - Your availability is visible to everyone, favourites or no one
    ([help](https://support.focusmate.com/en/articles/6377602-availability-setting-and-the-see-availability-page)).
  - Snooze and block never tell the other person
    ([help](https://support.focusmate.com/en/articles/16056647-understanding-the-difference-between-snooze-and-block)).

**Study Together** (now points new users to StudyStream, [home](https://studytogether.com/))
- Time counts in calls except the break and AFK channels; stats appear 15–30 min later.
- Anyone who hasn't posted a goal within 10 min is moved to AFK ([FAQ](https://studytogether.com/faq)).
- Leaderboards by day, week, month and all time (possibly outdated:
  [API](https://github.com/Study-Together-Org/study_api)).

**Duolingo**
- No live presence found.
- Friend streaks: up to 5 friends, with capped nudges ([blog](https://blog.duolingo.com/friend-streak/)).
- Friends Quests ([blog](https://blog.duolingo.com/friends-quests/)).
- Leagues; you leave them by making your profile private
  ([blog](https://blog.duolingo.com/duolingo-leagues-leaderboards/)).
- A feed with congratulations (unverified).

**Strava**
- *Feed:* finished activities only
  ([help](https://support.strava.com/en-us/articles/15402105-how-does-strava-order-my-activity-feed)).
- *Live:* Beacon is the only live view: an opt-in link for up to 3 contacts, updated about every
  15 s ([help](https://support.strava.com/en-us/articles/15401829-strava-beacon)).
- *Privacy:*
  - Visibility is set per activity: Everyone, Followers or Only You
    ([help](https://support.strava.com/en-us/articles/15401987-how-do-my-activity-privacy-controls-work-on-strava)).
  - Flyby is off by default ([help](https://support.strava.com/en-us/articles/15401763-what-are-my-privacy-defaults-when-i-create-a-strava-account)).
  - Under-18 defaults: followers-only, off leaderboards
    ([help](https://support.strava.com/en-us/articles/15401723-what-are-my-privacy-control-defaults-on-strava-when-i-m-under-18)).
  - Upload alerts are opt-in per athlete
    ([help](https://support.strava.com/en-us/articles/15402056-how-do-i-follow-athletes-on-strava)).

### 1.4 Mechanics side by side

| App | Idle / away | Presence send rate | Avatars, cursors shown | Follow ends on | Followed person told? |
| --- | --- | --- | --- | --- | --- |
| tldraw | idle 3 s; inactive (hidden) 60 s | 30/s with others, none alone | 5 avatars + count | your own input | yes, "Following you" |
| Excalidraw | idle 60 s; away when tab hidden; 30% opacity | cursor ≤ 30/s; "active" every 3 s | up to 8 avatars | scroll, zoom, click | no |
| AFFiNE | none (y-protocols drops at 30 s) | canvas cursor ≤ once a frame | no facepile | no follow | — |
| Figma | none documented | — | — | "Stop following" | no |
| Google Slides | — | — | pointers may stop above 20 | your own edit or selection | follower gets a badge |
| Slack | away after 10 min | batched events | ~500 presence subscriptions | — (no follow) | — |
| Teams | away after a few minutes; two 5-min steps | — | spotlight 7 videos | "Exit spotlight" | — |
| Discord | idle (time not stated) | 5 activity updates per 20 s | — | — | — |
| **Capy today** | **none: y-protocols removes a peer after 30 s without renewal** | carets and pointers ≤ 20/s (`cursorThrottle.ts:2`) | 3 avatars + N, no tooltip (`openwiki/frontend/plate-editor.md:307-317`) | no follow | — |

Capy's switches today:
- "Show others' cursors" decides only what this device draws (`openwiki/frontend/plate-editor.md:393-399`).
- By decision, nobody can stop sending their own presence (`human/frontend/plate-editor.md:320`).

### 1.5 Patterns that matter for Capy

1. **Two layers: availability and activity.**
   - Availability is active, idle, away or offline. It is computed on the device from input and tab
     visibility: tldraw, Excalidraw, Slack, Teams.
   - Activity is a verb plus an item, a count and a start time: Discord Rich Presence, Teams
     "Presenting", Slack's huddle icon.
2. **Idle fades; it does not vanish.**
   - Excalidraw re-sends "active" every 3 s, marks a hidden tab "away", and draws idle peers at 30%.
   - tldraw hides only after 60 s inactive.
   - Capy and AFFiNE let y-protocols' 30 s removal decide, which is exactly where cause 1 bites
     (§2.2).
3. **One person, one entry.**
   - tldraw collapses tabs; Slack counts any active device; Teams uses the most recent device.
   - Google's duplicate "anonymous animals" is the anti-pattern.
   - Capy already shows one avatar per person (`src/features/collaboration/presence.ts:58-67`).
4. **Follow and spotlight.**
   - Follow is personal and ends on your own input (tldraw, Excalidraw, Slides).
   - Spotlight is a broadcast with a grace period (Figma "Not now", Miro "Bring everyone").
   - In quiz apps: host-paced vs self-paced.
   - Whether the followed person is told differs: tldraw yes, Figma and Excalidraw no.
5. **Live presence is never stored; history is a separate surface with opt-outs.**
   - Docs view history, Notion analytics, Linear feeds.
   - In study and fitness apps, *finished* activity (feeds, streaks) does the social work, and live
     presence stays thin (Strava, Duolingo, StudyStream).
6. **Peers see standing; the host sees detail.**
   - Kahoot shows a top 5; Wayground's who-answered-what is teacher-only; Mentimeter separates
     collecting names from showing them.
   - Nobody shows a peer's answers live.
7. **Privacy switches.**
   - Editors offer little: hide others' cursors (Figma, Slides). Slides' own pointer, off by
     default, is the one opt-in.
   - Social apps go per space or per item: Discord per server, Strava per activity, Focusmate
     availability to favourites, silent mute and snooze.
   - Minors get different defaults (Strava under 18, Kahoot and Wayground generated names).
8. **Notify on requests, not on presence.**
   - Mentions and assignments notify by default.
   - "A friend started a huddle" has its own switch (Slack).
   - Nudges are capped (Duolingo).

---

## 2. Diagnosis: why remote carets, pointers and block selections glitch or disappear

### 2.1 How presence works today

**Plate notes** (production path)

Sending:
- The caret goes out as base64 Yjs relative positions `s` (anchor) and `f` (focus, only when not
  collapsed):
  - `sendCaret` (`src/features/notes/notePresence.ts:175-192`) replaces slate-yjs's send;
  - it is throttled to 50 ms (`src/features/notes/NoteEditorCore.tsx:2113-2126`,
    `src/features/notes/cursorThrottle.ts:20-50`).
- The pointer goes as `p: [blockId, x, y]`, 0–1000 of the block box (`notePresence.ts:247-303`).
- Block selection runs go as `b` (`src/features/notes/BlockSelection.tsx:92-128`).
- Uploads go as `uploads` (`src/features/notes/uploadPresence.ts:35-53`).
- All of these merge in `setNotePresence`, which calls `awareness.setLocalState` only when a field
  changed (`notePresence.ts:130-151`).

The awareness timers:
- They are y-protocols 1.0.7: `outdatedTimeout` is 30 s (`node_modules/y-protocols/awareness.js:13`).
- One `setInterval` every 3 s renews this tab's state when it is at least 15 s old, and drops any
  remote state not updated for 30 s (`awareness.js:59-77`).

The provider (`src/features/collaboration/roomProvider.ts`):
- It listens to every awareness `update` (renewals included) and sends while joined and not paused
  (`:224`, `:866-888`).
- It resends the local state on JOINED (`:754-758`).
- When a channel ends it removes peers' states (`:802-806`).
- The tab's socket queues these "charged" frames under the tab's allowance and drops them during a
  timeout (`src/features/collaboration/socket.ts:202-221`).

The server (`collaboration-rs/crates/server/src/room.rs`), `on_awareness` (`:3827-3923`):
- It keeps only entries under the channel's own bound client id (`:3855-3860`).
- It checks the room kind's field list and the 4 KiB cap (`:3842-3869`;
  `collaboration-rs/crates/server/src/presence.rs:43-61`).
- It takes only a newer clock, or a removal at the same clock (`:3870-3883`).
- Relay happens in 30 ms flush windows (`FLUSH_WINDOW`, `:33`). Each member gets its update, then
  the awareness of clients it doesn't hold, then its ACK, in one frame (`:2980-3037`).

How the server stores, expires and replays awareness:
- **Store:** it keeps up to 256 ids per room (`:50`).
- **Expire:** never by time. An entry lives until its channel leaves. Then the server publishes
  `null` at clock + 1 on the client's behalf and forgets the entry after the flush
  (`:2942-2953`, `:3035-3036`).
- **Replay on JOIN:** a JOIN gets all stored non-null states, charged to the open budget
  (`:2882-2896`, `:3988-4004`).
- **Same-session reconnect:** when the old channel's socket dropped unseen, the new channel takes
  over the old one's entry instead of the server removing it (Q477, `:4360-4377`).

Labels, colours and the avatar group come from the stateless `room-presence` message:
- It goes to editors only, a flush window after a change and at most once a second (`:3927-3985`,
  `PRESENCE_EVERY` `:77`).
- It lists person number, name, avatar and client ids (`:5542-5552`).

Receiving:
- slate-yjs `CursorEditor` change events feed `useRemotePeers`
  (`src/features/notes/RemoteCursors.tsx:150-182`).
- Only clients the room presence lists are drawn (`:111-132`).
- `decorate` resolves the positions on the root entry once per document version (`:238-266`), and
  CSS draws a 2 px bar (`src/styles/tailwind.css:604-614`).
- Pointers and block outlines are an absolutely placed overlay (`RemoteCursors.tsx:390-535`).

**BlockSuite notes (this branch)**
- `createBlocksRoom` builds an `ItemRoom` with `awareness: true`
  (`src/features/notes/blocksuite/blocksRoom.ts:48-50`). Only write access passes that awareness to
  the provider (`src/features/collaboration/itemRoom.ts:259`, `:352`).
- BlockSuite's `AwarenessStore` writes `selectionV2` into it as soon as the store opens:
  - `vendor/blocksuite/framework/store/src/yjs/awareness.ts:25-28`;
  - `src/features/blocksuite/roomStore.ts:86-88`;
  - the e2e expects exactly that key (`e2e/editor/blocksuite-note.spec.ts:121-124`).
- The remote-selection view extension is switched off (`src/features/blocksuite/pageEditor.ts:46-51`).
- The plan is to port the widget to read room presence (`todo-blocksuite-decisions.md:367-376`,
  `todo-blocksuite-layout.md:263-274`), and presence is Epo's own session
  (`todo-blocksuite-decisions.md:600`).

**Office files**
- The editor's `cursor` goes into the source room's awareness (`src/features/files/officeCursors.ts:149-190`).
- Peers are drawn only when the state holds nothing but a valid cursor (`:79-85`) and the room
  presence gives the id a name (`:128-143`; `presenceNames` skips nameless connections,
  `src/features/collaboration/presence.ts:70-79`).
- BetterOffice draws the flags.
- Office uses the same provider and server path as notes.

**Items** (quiz, set, Mermaid, embeds): the room kind admits no awareness fields
(`presence.rs:38-40`, `:46-48`). They get room presence (avatars) only.

**Workspace level:** none.
- `RoomPresence` renders only in the open document's header
  (`src/features/materials/CenterContentHeader.tsx:494`).
- Nothing appears in the file tree or on cards.
- collaboration-rs has no occupancy endpoint (`collaboration-rs/crates/server/src/http.rs:24-50`).

### 2.2 Likely causes, ranked

#### 1. A hidden tab stops renewing, so co-editors drop its caret after 30 s and it blinks back once a minute (high confidence in the mechanism)

- **What happens:**
  - The only thing that keeps an idle tab's presence alive is y-protocols' 3 s interval, which
    renews at 15 s (`awareness.js:59-77`).
  - Capy adds nothing on top. The provider sends what that timer emits (`roomProvider.ts:866-888`).
    The server neither refreshes nor times entries; it relays only newer clocks (`room.rs:3870-3883`).
  - Chrome checks timers in a page hidden for more than 5 minutes only once a minute, and a
    `setInterval` counts toward the chain rule
    ([Chrome](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)).
  - So a co-editor whose tab has been in the background 5+ minutes renews about once a minute. Every
    peer's own interval removes the state 30 s after each renewal (`awareness.js:69-76`), and the
    next renewal brings it back.
- **What users see:**
  - The caret and block outline appear and disappear on a ~60 s cycle.
  - The pointer is already cleared when the tab hides (`notePresence.ts:287-289`).
  - Office cursors behave the same, through the same provider.
  - The same happens whenever a tab's timers starve: a frozen or discarded tab, a phone with the app
    in the background, or (unverified) a window that macOS reports fully covered.
- **Confirm:**
  - (a) Two Chrome profiles on UAT. B places a caret and switches to another tab for 6+ minutes. On
    A, log `awareness.on('change')` with `Date.now()` and B's `awareness.meta.get(id).lastUpdated`.
    Expect "removed" and "updated" for B about every 60 s.
  - (b) A Playwright spec that freezes B with CDP `Page.setWebLifecycleState({ state: 'frozen' })`
    for 40 s. Expect A's `[data-remote-caret]` to detach at about 30 s.
  - (c) A temporary log on B of each renewal (an `update` with origin `local` and an unchanged
    state). Expect gaps near 60 s after 5 minutes hidden.
- **Compare:** Excalidraw publishes "away" on a hidden tab and re-sends "active" every 3 s; tldraw
  derives idle from `lastActivityTimestamp` (§1.1). Neither lets presence vanish on a timer.

#### 2. After a rejoin the server saw coming, the rejoined tab is invisible until its second awareness change, and the rejoining tab misses idle peers (high confidence; documented as accepted)

The steps:
- When a channel ends, the server publishes `null` at clock + 1 for its client and then forgets the
  entry (`room.rs:2942-2953`, `:3035-3036`).
- On JOINED the tab resends its state at its own unchanged clock (`roomProvider.ts:754-758`; the
  encoder writes the stored clock, `awareness.js:194-207`).
- Peers take only a strictly newer clock (`awareness.js:255-256`). So they drop the resend
  (`c < c+1`) and the next change too (equal clock, not a removal). The caret returns at the second
  change.
- That is instant for someone typing, but up to two renewals (~30–36 s) for someone reading.
- The editor doc states this outcome (`openwiki/frontend/plate-editor.md:1724-1727`).
- The reverse direction:
  - `endChannel` removes peers' states (`roomProvider.ts:802-806`).
  - y-protocols keeps a removed remote client's clock (`awareness.js:167-187`), so the JOIN replay at
    the same clocks is ignored.
  - Idle peers come back only at their next renewal (≤ ~18 s).
- A third case:
  - A state at clock 0 from an unknown client is ignored, because the current clock defaults to 0
    (`awareness.js:255`).
  - `adopt()` moves the current state to a new id at clock 0 (`roomProvider.ts:728-737`), so the
    first state under a new id is never shown.

Triggers (every one is routine):
- A socket close or drop the server noticed. It pings every 30 s and closes sockets silent for 60 s
  (`collaboration-rs/crates/server/src/socket.rs:67-72`).
- The idle close after 60 minutes without input (`src/features/collaboration/idle.ts:10`,
  `socket.ts:163-170`).
- Token expiry when the in-band refresh fails. Tokens last 5 minutes
  (`server/internal/httpapi/collaboration_tokens.go:81`; `socket.rs:1353-1389`).
- A re-JOIN after a timeout on the same channel, which the server handles as a Leave first
  (`socket.rs:757-762`; `roomProvider.ts:387-403`).
- Oldest-closed parking (`roomProvider.ts:130-133`).
- Only an unseen socket drop is covered by the Q477 takeover.

Confirm:
- A Vitest in `src/features/collaboration/roomProvider.test.ts`, beside "applies remote awareness and
  sends back only its own re-asserted state" (`:959`):
  - a peer Awareness has seen `(own, k+1, null)`;
  - the provider rejoins;
  - feed its JOINED awareness frame to the peer and expect the state present. It fails today.
- A Rust case in `collaboration-rs/crates/server/tests/rooms.rs`: B at clock 5, B's socket closes, B
  rejoins and resends 5. Assert A receives a state it would accept. Today it gets `(6, null)` then
  `(5, state)`.
- A field log: count incoming awareness entries whose clock is at or below the known clock.

#### 3. Any scroll in the page, or any window blur, clears the pointer, so pointers flicker (high confidence; pointers only)

- **What happens:**
  - `sendPointer` sends `p: null` on any `scroll` event in the whole document, through a capture
    listener on the document (`notePresence.ts:292`).
  - It does the same on window blur (`:294`), on pointerleave and when the tab hides.
  - The pointer comes back only on the next `pointermove` (50 ms throttle plus an animation frame).
- **What users see:**
  - A still pointer blinks for every co-editor while anything else scrolls: a streaming chat
    answer's auto-scroll beside the note, the file tree, a code block or table.
  - Window blur also fires when focus moves into an iframe (Office runtime, HTML embeds; unverified
    per embed).
  - The documented reason covers only the note's own scroll (`openwiki/frontend/plate-editor.md:357-359`).
- **Confirm:** a Vitest that dispatches `scroll` on an element outside the note root and checks `p`
  (it becomes null today). Then an e2e with a streaming chat that records A's
  `[data-remote-pointer]` detach and attach events while B's mouse is still.

#### 4. Remote-presence re-renders snap the local caret back (medium confidence; the local caret glitches)

- **What happens:**
  - A peer's caret or label change sets React state (`RemoteCursors.tsx:150-182`). That re-renders
    the whole Editable, as the code comment says (`:151-156`).
  - On every render, slate-react resets the DOM selection to `editor.selection` when the two differ
    (`node_modules/.pnpm/slate-react@0.126.4…/dist/index.es.js:2802-2888`).
  - Native caret moves reach `editor.selection` only through a selectionchange handler throttled to
    100 ms (`:2715-2775`).
  - A co-editor's caret updates at up to 20 Hz (`cursorThrottle.ts:2`), so they can undo arrow or
    End moves.
- **Evidence it bites:** `e2e/sharing/live-collaboration.spec.ts:42-45` avoids bare End for this
  reason.
- **Confirm:** an e2e where page A types continuously and page B presses ArrowRight 30 times fast in
  another paragraph, asserting B's final offset. Expect intermittent shortfalls. Or count slate-react
  `setBaseAndExtent` calls during renders that only peers' presence triggered.

#### 5. Behaviour that is by design but reads as "the caret disappeared" (certain)

- **Block selection:**
  - Starting a block selection blurs and deselects the editor
    (`@platejs/selection/dist/react/index.js:1250-1251`).
  - `sendCaret(null)` then removes `s` and `f` (`notePresence.ts:180-182`).
  - Peers see the outline but no caret. Once the block selection clears they see nothing until the
    person clicks into text again.
- **Voids:** a caret on a block void (image, equation, embed) is never drawn
  (`openwiki/frontend/plate-editor.md:231-234`).
- **Embeds:** item rooms carry no awareness (`presence.rs:38-40`), so someone working inside an
  embedded quiz shows nothing.
- **No name flag:** the caret has only the `data-remote-caret` attribute and a bare 2 px bar
  (`tailwind.css:604-614`). The C2 flag from `human/frontend/plate-editor.md:245` is not drawn in
  notes, so a caret is easy to lose.
- **Confirm:** e2e checks of `[data-remote-run]` and `[data-remote-caret]` while B drags a block
  selection, then after Esc.

#### 6. Colour and label churn around joins (medium confidence)

- A caret is drawn only for a client id the latest room presence lists (`RemoteCursors.tsx:120-121`,
  `:317-318`). The presence follows a change by a flush window and at most once a second
  (`room.rs:3927-3934`), so carets appear up to ~1 s after their state does.
- Person numbers, and with them colours (`person % 8`, `RemoteCursors.tsx:126`), are re-issued:
  - each presence send forgets users with no listed channel (`room.rs:3951-3955`);
  - a returning user gets the next number (`:3959-3965`).
- So after a reconnect gap longer than the next presence send (the client backs off 0.5–1.5 s at
  first, `socket.ts:354-368`), the person's colour changes.
- **Confirm:** a Rust case. B leaves, the presence goes out, B rejoins; assert A's presence still
  gives B the same `person`. It fails today.

#### 7. The overlay drifts (medium-low confidence)

- Pointers and block outlines are absolute boxes measured at layout time. They are re-placed only
  when:
  - that peer's awareness changes;
  - the document updates;
  - the room presence changes;
  - the editor root resizes (`RemoteCursors.tsx:440-467`).
- A nested scroll (a wide table or a code block), an animation, or a change that keeps the root's
  size leaves them misplaced.
- Coordinates relative to the block box (0–1000, `notePresence.ts:218-238`) also point at
  different words when two people's widths differ.
- **Confirm:** an e2e where B selects a block inside a horizontally scrolled table and A scrolls the
  table. The outline stays where it was.

#### 8. BlockSuite notes on this branch: nothing is drawn, nothing is relayed, and a latent crash (high confidence)

- **Nothing is drawn:** `RemoteSelectionViewExtension` is in `OFF` (`pageEditor.ts:46-51`).
- **Nothing is relayed:**
  - A blocks note is a note room on the server: `kind == "note"`, model `Blocks`
    (`room.rs:561-571`).
  - Its field list therefore admits only `s`, `f`, `p`, `b` and `uploads`
    (`room.rs:3842-3847`; `presence.rs:52-59`).
  - Every state holding `selectionV2` is dropped whole, `uploads` included, and nobody is told.
- **Latent crash:**
  - BlockSuite's selection extension reads each remote state with
    `Object.entries(state.selectionV2)` (`vendor/blocksuite/framework/store/src/extension/selection/selection-extension.ts:83`).
  - The only states the server lets through are those *without* `selectionV2`. Examples:
    - a `{}` renewed (clock 1+) by a channel whose editor has not mounted 15 s after joining, for
      example during a slowed open or a hold. The first `{}` goes at clock 0, which peers ignore;
    - the provider's own awareness on a non-viewer channel without write access
      (`roomProvider.ts:221`; `itemRoom.ts:352`).
  - Such a state throws a TypeError. lib0's emit doesn't catch it
    (`node_modules/.pnpm/lib0@0.2.117/node_modules/lib0/observable.js:80-83`), so it leaves
    `applyAwarenessUpdate`, then `RoomProvider.onMessage` (`roomProvider.ts:467-469`), then the
    socket loop (`socket.ts:332-340`).
  - The rest of that frame is lost. The server packs a member's update, then awareness, then ACK
    (`room.rs:3002-3029`), so a lost ACK can leave `unsyncedChanges` above zero until the next
    rejoin.
- **When the widget returns:** BlockSuite keeps absolute `{blockId, index}` positions, which drift
  under concurrent typing (`todo-blocksuite-decisions.md:375-376`), and a random colour
  (`remote-color-manager.ts:14-19`).
- **Confirm:**
  - A Vitest: `openRoomStore` with an Awareness, then `applyAwarenessUpdate` with a remote `{}` at
    clock 1. It throws today.
  - A Rust case: a blocks room relays `{"selectionV2":{}}`. It is dropped today.

### 2.3 Checked and not the cause

- **Renewals reach peers.** The provider listens to `update`, not `change` (`roomProvider.ts:224`).
  The server takes a renewal because its clock is newer, and flushes it (`room.rs:3870-3910`).
- **The server never expires or rewrites entries by time.** Removal happens only on leave.
- **Plate carets use relative positions.** They are encoded once (`notePresence.ts:153-192`) and
  resolved per document version (`RemoteCursors.tsx:195-266`). Root-type positions are skipped
  (`notePresence.ts:157-167`).
- **Decorations survive chunking** (`chunkSize: 32`, `NoteEditorCore.tsx:1667`). slate-react 0.126
  recomputes the root decorations every render (`dist/index.es.js:3256`) and re-renders the chunks
  whose decorations changed (`:2248-2360`).
- **No editor remount on reconnect.** Plate connects the Yjs editor once, in `init`
  (`@platejs/yjs/dist/BaseYjsPlugin-C6Yzeyrr.js:546`). A room swap remounts only on a lineage change or
  late GC (`src/features/notes/NoteEditor.tsx:437-460`).
- **The throttle keeps the latest selection** (`cursorThrottle.ts:34-45`).
- **Token refresh happens in-band.** It rejoins only if the fetch fails (`roomProvider.ts:512-522`;
  `socket.rs:1353-1389`).
- **The allowance is not the limit.** It is 200 messages and 2 MiB a second after a burst
  (`openwiki/frontend/plate-editor.md:1352-1360`), far above presence rates. The 2026-10-28 load test
  ran with carets always moving and no drops, so it could not show causes 1 or 2
  (`bench/collaboration/reports/2026-10-28-presence-load.md:38-44`, `:61-66`).

### 2.4 Instrumentation worth adding (no fixes)

- **A debug panel for each peer:** client id, last clock, age of `lastUpdated`, whether the room
  presence lists it, and whether `s` decodes and resolves. That separates causes 1, 2, 5 and 6 in a
  minute.
- **Server counters:**
  - awareness entries dropped, by reason (not its own id, field list, size, stale clock, room cap);
  - removals published on leave.
- **On the sender:** log renewal gaps over 20 s.

---

## 3. Activity panel: what data exists and how it could flow

### 3.1 What exists today

From an inventory pass over `server/`, `pipeline/` and `src/`; I spot-checked the SSE, migration
and collaboration claims.

| Source | Where | Scope, who may read | Live or history | What a panel lacks |
| --- | --- | --- | --- | --- |
| Room awareness: note `s` `f` `p` `b` `uploads`, Office `cursor` | `room.rs:3827-3923`, `notePresence.ts` | One material room; editors only, viewers never | Live; ~30 s life | Nothing above room level; no verb |
| Room presence: person, name, avatar, client ids | `room.rs:3942-3985`, `presence.ts` | Editors in that room; person numbers, never user ids | Live | Per room; header only |
| SSE `/api/stream`, `notification` events (`created`, `read`, `customization`, `billing`, `chat_turn`, `ingest`) | `server/internal/httpapi/sse_events.go:27-50`, `:79-207`; `src/api/hooks.ts:516-618` | One user, all their tabs | Live; no replay (refetch on connect) | User-scoped only |
| SSE `ingest` (`{fileId, stage, pct, status}`) | `pipeline/pipeline/progress.py:41-63` | Anyone with workspace read, link and public visitors included (`sse_events.go:89-93`) | Live | No actor |
| SSE `tree` (`{kind}`) | `server/migrations/0004_workspace_tree_notify.sql`, `sse_events.go:213-224` | Same | Live | No actor; content edits raise none |
| Uploads: `upload_sessions` (`created_by`, `name`, size), `files.created_by` | `0001_init.sql:1587-1625`, `:240-255`; `store/uploads.go:228` | Not exposed; `files` row exists only after finalize | Database | "Sam is uploading" is invisible |
| Jobs and ingest attempts, `source_batches` | `0001_init.sql:1057-1130`; `0061_source_batches.sql:8-55` | Ops; one notification to the actor | Database | Actor in the payload only |
| Chat: `conversations`, `messages.status = streaming`, in-memory `runningTurn` | `0001_init.sql:776-801`; `store/chat.go:31-32`, `:218-312`; `chat_resume.go:11-53` | Owner only, even in workspace chats | Live for the owner | Nothing for others |
| `/generate`, `agent_operations`, open `provider_sessions` | `huma_generate.go`; `0001_init.sql:832-846`, `:2409-2436` | Internal | Database | Would mark "generating" |
| Study: `attempts`, `review_sessions` (`started_at`, `last_answer_at`, `finished_at`), `study_progress`, plans | `0071_review_sessions.sql:10-43`; `0094`; `0108`; `0051` | Private to the user; owners and editors get only an aggregate count and average (`store/queries.go:302-314`) | Database; in-progress only implied | No live signal; privacy policy |
| Notifications | `0001_init.sql:651-663`; `store/notifications.go:70-71` | Recipient only | 30-day read window, never swept | No activity kinds |
| `item_opens`, `workspace_visits` | `0120_workspace_visits.sql:22-45`; `store/opens.go:11-15` | The user only | At most one write per 5 minutes | Could feed "recently here" |
| `material_yjs_client_ids` (user per client id, `last_write_at`) | `0115_collaboration_client_ids.sql:1-25` | Server only ("readers never learn them") | Database | Edit attribution |
| PPTX presenting | `useOfficeRuntime.ts:667-668` | The local page only | — | No signal at all |

**Gaps:**
1. No workspace-level event names a person, and workspace streams also reach non-members.
2. Uploads in progress, chat and generation runs, and study in progress have no record other members
   can read.
3. Material edits raise no event outside the room.
4. There is no workspace-level online state.
5. The attribution columns that exist are deliberately kept out of the API (`store/models.go:416-419`).

### 3.2 What the panel needs

One row per person, not per tab (pattern 3). Each row holds:
- **who:** verified name and avatar (as room presence does today);
- **availability:** active, idle, away or offline, from input and visibility (pattern 2);
- **where:** item id and kind, plus an optional coarse place (block, slide, page);
- **doing:** one of
  - editing, viewing, or selecting *n* blocks;
  - presenting (slide *k*);
  - quiz, flashcards or review (*k* of *n*, no correctness; pattern 6);
  - uploading (*n* files, %);
  - generating (deck, quiz or note: running or finished);
- **since** and **last active**;
- **canvas:** viewport and "following" for follow and spotlight (tldraw's `followingUserId`;
  Excalidraw sends the viewport only while followed);
- **share flags.**

An optional feed would add finished events only: "finished a review", "generated a deck",
"uploaded 3 files" (Strava and Duolingo style, pattern 5).

### 3.3 Three architectures

**A. Client-reported fields in the workspace canvas room's awareness**

*Precedent:* tldraw's presence record, Excalidraw's collaborator map, AFFiNE's edgeless awareness,
Discord Rich Presence.

*Shape:*
- A `Fields::Canvas` list in `presence.rs`:
  - `v` viewport;
  - `p` canvas pointer in model coordinates (the canvas report notes BlockSuite's widget is off,
    `A-canvas.md` §8.3 item 9);
  - `sel`, at most 16 item ids;
  - `at`: `[itemId, verb, k?, n?]`;
  - `st`: active, idle or away;
  - `follow`.
- Every tab joins the canvas room while inside the workspace, even with a material open, so the
  roster covers everyone in the workspace UI.
- Labels come from room presence.

*Cost:*
- No database and no Redis; one field list (Rust and TS) and the panel.
- A state of about 100 B renews every 15 s. Egress is roughly N × (N−1) × rate × size: about
  1 KB/s for 10 tabs at renewal rate. Canvas pointers at 20 Hz dominate, and the 2026-10-28 bench
  measured 14,700 carets a second at 0.67 core.
- Each tab holds one more joined channel, against the 22-per-user cap
  (`collaboration-rs/crates/server/src/seats.rs:28-34`).
- **Prerequisite:** causes 1 and 2, otherwise the panel blinks.

*Privacy:*
- Self-reported: a per-workspace "share my activity" switch simply stops writing `at`, as with
  Discord's per-server switch. Nothing is stored.
- Viewers already get no presence, and link visitors never join.
- A modified client could claim an activity it isn't doing. That matters little among friends.

*Limits:*
- Nothing survives the tab: a generation still running on the server or an ingest disappears with
  it.
- Members who are not in the workspace UI don't appear.

**B. A workspace presence hub in collaboration-rs, derived on the server**

*Precedent:* Slack and Teams presence services (computed across devices, ranked), and Google Docs'
server-side list of active people.

*Shape:*
- A per-workspace task keyed by the workspace id in the tokens.
- Each material or source room reports join, leave and "wrote within N s".
- Clients add study verbs through a checked stateless message.
- The hub sends `workspace-presence` at most once a second, like `room-presence`.

*Cost:*
- New server code and cross-task messages. Cheap while everything runs in one process.
- The design runs one instance per environment and plans document-sticky routing, not Redis fan-out
  (`openwiki/frontend/plate-editor.md:3907-3911`). One workspace's rooms on different instances
  would then need fan-out or workspace-sticky routing.

*Privacy:*
- Editing and viewing are true, because they are derived. But they are shown without a per-action
  choice unless the hub honours a share flag from the token.
- It must stay members-only. Nothing is stored.

*Limits:* uploads, chat and quizzes still need client or gateway input.

**C. Gateway SSE fan-out, optionally with a stored feed**

*Precedent:* Linear's Inbox and activity, Drive's activity panel, Notion's updates and analytics,
Strava and Duolingo feeds, Wayground's teacher-only Pulse.

*Shape:*
- A members-only Redis channel `activity:{wsId}` on the existing broker
  (`server/internal/httpapi/fanout.go:17-28`), delivered as an `activity` SSE event.
- Producers already know the actor:
  - upload sessions (start and finalize);
  - `source_batches` and ingest (with the job's `actorUserId`, `store/jobs.go:219-223`);
  - chat turn start and end;
  - `/generate`;
  - `review_sessions` (first answer and `finished_at`) and attempts;
  - presenting, through a small POST;
  - `item_opens`.
- `GET /api/workspaces/{id}/activity` returns a snapshot, since the stream has no replay.
- Optionally a `workspace_activity` table of finished events, kept 7–30 days and purged by a job.

*Cost:*
- One Redis publish per event; the SSE streams are already open.
- A new members-only check: today's workspace stream reaches any reader (`sse_events.go:89-93`).
- Database writes and a purge job if there is a feed.
- Latency of tens to hundreds of ms: fine for activity, not for cursors.

*Privacy:* the highest of the three.
- It records and broadcasts study and chat behaviour that is private by design today:
  - progress is private to its user (`openwiki/study-progress.md`);
  - chat is owner-only (`store/chat.go:218-233`).
- It needs:
  - opt-in or a per-workspace switch;
  - coarse states (no scores, no answers, no chat text);
  - limited retention;
  - deletion on account purge;
  - no link or public visitors;
  - defaults off for school and minor accounts (Strava under 18, Kahoot).
- All of this needs Epo's sign-off.

*Limits:* coarse timing; no cursors.

**Combined:** A for live "who is where, doing what"; C only for server jobs that outlive the tab
(uploads, ingest, generation) and, if Epo wants it, an opt-in feed of finished activities; B only
if presence is needed without the canvas mounted. This mirrors the comparison: live presence
travels in the editor's presence channel, and history is a separate surface with its own opt-outs.

### 3.4 Questions for Epo

1. Who may see activity: members only? Never link or public visitors?
2. Should sharing activity be opt-in or opt-out, per workspace? Separate switches for editing and for
   studying?
3. How much study detail: "in a quiz" only, "7 of 20", or results after finishing?
4. Live only, or also a feed of finished activities? Kept for how long?
5. Which idle and away timings? tldraw uses 3 s and 60 s, Excalidraw 60 s plus a hidden tab, Slack
   10 minutes, Teams about 5 minutes.
6. Which follow model:
   - personal follow, or a presenter spotlight with "Not now";
   - does the followed person see who follows them (tldraw yes, Figma no)?
7. Several devices: which one wins (the most recent, as in Teams)?
