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
