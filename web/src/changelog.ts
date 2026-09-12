/**
 * Release history, newest first. The top entry's version is the app version
 * shown in the account menu; when it changes, the What's New sheet is shown
 * once after the update is applied. Add an entry for every user-visible
 * change.
 */

export interface Release {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: '2.8.1',
    date: '2026-09-12',
    title: 'No more “Failed: Upload is COMPLETED”',
    changes: [
      'A file finished by your other device now shows Done here, not Failed',
      'Old stuck “Failed” cards heal themselves on the next app launch',
    ],
  },
  {
    version: '2.8.0',
    date: '2026-09-11',
    title: 'Bond all your networks: vvup CLI',
    changes: [
      'New terminal uploader that combines Wi-Fi + tethered phones + ethernet into one fat pipe',
      'Parts of a single big file spread across every connection — aggregate speed, no VPN needed',
      'Same rules as always: resumable, dedup-safe, originals untouched (see README)',
    ],
  },
  {
    version: '2.7.0',
    date: '2026-09-11',
    title: 'Continue uploads on another device',
    changes: [
      'Started uploading from the phone? Move the SD card to the laptop, pick the same files there — the upload continues from exactly where it left off',
      'Already-uploaded parts are never sent again, on any device',
      'Pause the upload on the first device before switching, so they don\u2019t compete',
    ],
  },
  {
    version: '2.6.0',
    date: '2026-09-11',
    title: 'Smarter parallel uploads + your choice',
    changes: [
      'Big files no longer share bandwidth with each other — one large video at a time, finishing as fast as possible',
      'Small files still fill the spare bandwidth alongside a big upload',
      'New Upload mode setting in Transfers: Smart or strictly One at a time',
    ],
  },
  {
    version: '2.5.3',
    date: '2026-09-09',
    title: 'No more blank page after an update',
    changes: [
      'Fixed a caching problem that could leave the app showing a blank page for a few hours after a new version was deployed',
      'The page itself is no longer cached by the CDN, so a new version is picked up immediately instead of being served a stale reference to it',
    ],
  },
  {
    version: '2.5.2',
    date: '2026-09-09',
    title: 'Opening a photo is fast now',
    changes: [
      'Opening a photo no longer downloads the full-resolution original — a 40 MP drone shot took several megabytes and a lot of your device’s memory just to look at',
      'The viewer now loads a display-sized copy instead, so photos appear almost immediately and stepping through a folder stays quick',
      'Download still gives you the untouched original, bit for bit',
      'The blurred preview now fills the screen at the right size instead of appearing small and then jumping when the sharp version arrived',
    ],
  },
  {
    version: '2.5.1',
    date: '2026-09-09',
    title: 'Photo grids load properly now',
    changes: [
      'Fixed photos that could sit blank for minutes the first time you opened a folder — tiles were quietly downloading the full-size original while their thumbnail was still being made',
      'A folder now shows placeholders that fill in within seconds instead of competing for your connection',
      'Scrolling into a new stretch of a big folder makes those photos first, rather than queueing them behind everything above',
      'The app keeps waiting for slow thumbnails instead of giving up after a minute and leaving tiles empty',
    ],
  },
  {
    version: '2.5.0',
    date: '2026-09-07',
    title: 'Instant photo viewer, much faster grids',
    changes: [
      'Photos and videos now open in place — closing one returns you to the exact spot you were scrolled to, with nothing reloading',
      'Step through a folder with the arrows beside the photo, your keyboard, or a swipe',
      'Photo grids load small thumbnails instead of full-size originals — dramatically less data and far quicker to fill',
      'Opening a photo shows it immediately, sharpening as the original arrives; the next and previous are loaded ahead of you',
      'Coming back to a folder from anywhere in the app is instant instead of a fresh load',
    ],
  },
  {
    version: '2.4.0',
    date: '2026-09-07',
    title: 'Folder sharing, faster small files, visible progress',
    changes: [
      'Folder-only accounts: create a user who sees just the folders you grant (Users → Library access)',
      'Grant folders per person via folder menu → Who can access — without hiding them from others',
      'Small files now upload several at a time; big files keep their parallel parts',
      'A floating progress pill on every page shows live upload/download progress — tap it for Transfers',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-09-05',
    title: 'Drag & drop',
    changes: [
      'Drop files anywhere on a project or folder page to upload them right there',
      'Dropping a whole folder uploads everything inside it',
      'Same pipeline as always: originals, resumable, duplicates skipped',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-09-04',
    title: 'Select all & type filters',
    changes: [
      'Filter a folder by Videos, Photos, or Other files',
      'Select all (respects active filters) — then Download, Move, or Delete the lot',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-09-04',
    title: 'A real desktop experience',
    changes: [
      'Sidebar navigation and wide layouts on desktop — no more phone app in the middle of the screen',
      'Grid view with real photo thumbnails (toggle next to Select)',
      'Projects and folders flow into multiple columns on bigger screens',
      'Wider player and tidier Transfers/Users pages on desktop',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-08-31',
    title: 'Privacy controls',
    changes: [
      'Hide any file from members — only you and admins see it',
      'Restrict a folder to specific people (admin, via folder menu → Who can access)',
      'Enforced on the server: hidden and restricted content is invisible everywhere, links included',
      'Folders show who created them',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-08-31',
    title: 'Everything, not just videos',
    changes: [
      'Upload any file — photos, videos, audio, documents, all in original quality',
      'Record a video or take a photo straight from the camera into the upload queue',
      'The viewer previews images and audio, not just video',
      'Clear error instead of a crash when the app and server versions drift apart',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-08-31',
    title: 'Dedup, bulk downloads & clarity',
    changes: [
      'Re-picking files is always safe: already-uploaded ones are skipped, interrupted ones resume',
      'Editors: select videos → Download all into one folder, sequentially, fully resumable',
      'Search, status filter, and sorting for big folders',
      'Transfers shows a live overview: current file, speed, files left, time estimate',
      'The active transfer sorts to the top — never buried under the queue',
      'Retries are visible on the card instead of looking frozen',
      'Small API calls now time out instead of silently freezing the queue',
      'Registered-but-waiting videos show “Pending upload” instead of “Uploading”',
    ],
  },
  {
    version: '1.7.1',
    date: '2026-08-31',
    title: 'Correct video counts',
    changes: [
      'Fixed: projects and folders always showed “0 videos” even when full',
      'Counts refresh live as uploads finish',
      '“Clear all” button for the finished-transfers list',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-08-31',
    title: 'Update on demand',
    changes: [
      '“Check for updates” in the account menu fetches the newest version immediately',
      'Tells you when you are already on the latest build',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-08-31',
    title: 'Fast with huge libraries',
    changes: [
      'Lists render only what is on screen — 600 videos scroll smoothly',
      'Progress updates repaint just the transferring row, not the whole list',
      'Queued uploads show as a count instead of hundreds of cards',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-08-31',
    title: 'Reload protection',
    changes: [
      'One-tap “Re-select all” banner re-attaches every interrupted upload — pick all files in one go',
      'The browser now warns before reloading or closing while uploads are running',
      'The screen stays awake while transfers are active',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-08-31',
    title: 'Versioning & smoother updates',
    changes: [
      'This screen — every update now tells you what changed',
      'App version visible in the account menu',
      '“New version available” prompt instead of silent updates',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-08-31',
    title: 'Bulk uploads that actually scale',
    changes: [
      'Pick hundreds of videos at once — they queue instantly',
      'One registration request instead of one per file',
      'Storage uploads start only when a file begins transferring',
      'Much faster resume check after reopening the app',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-08-31',
    title: 'Cleaner look & multi-select',
    changes: [
      'Select multiple videos to move or delete in one go',
      'Redesigned flat interface with proper icons',
      'Segmented role picker when creating accounts',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-08-31',
    title: 'New navigation',
    changes: [
      'Library and Transfers replace the old Upload/Browse/Editor tabs',
      'Upload directly into the folder you are viewing',
      'Move videos between folders',
      'All video actions in one bottom sheet',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-31',
    title: 'First release',
    changes: [
      'Resumable original-quality uploads to private cloud storage',
      'Resumable downloads for the editor',
      'Projects, folders, accounts, and in-browser playback',
    ],
  },
];

export const APP_VERSION = CHANGELOG[0]!.version;
