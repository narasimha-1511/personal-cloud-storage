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
