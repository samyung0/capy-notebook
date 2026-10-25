import type { Question, SourceFile, SourceSession } from '@/api/types';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import {
  createMaterialDocument,
  flashcardsNode,
  quizNode,
} from '@/features/materials/document';
import { deleteDocumentDrafts, draftKey } from '@/lib/editDrafts';
import xlsxURL from '../../e2e/fixtures/files/basic/grades.xlsx?url';
import docxURL from '../../e2e/fixtures/files/basic/lesson.docx?url';
import pptxURL from '../../e2e/fixtures/files/basic/lesson.pptx?url';
import pdfURL from '../../e2e/fixtures/files/basic/three-pages.pdf?url';
import blankDocxURL from '../../vendor/betteroffice/crates/office-service/starters/blank.docx?url';
import blankXlsxURL from '../../vendor/betteroffice/crates/office-service/starters/blank.xlsx?url';
import {
  resetScenarioRooms,
  sourceRoom,
  sourceRoomName,
  sourceRoomState,
} from './collaboration';
import * as db from './db';
import blankDocxStateURL from './fixtures/blank-docx-checkpoint.bin?url';
import blankXlsxStateURL from './fixtures/blank-xlsx-checkpoint.bin?url';
import docxStateURL from './fixtures/docx-checkpoint.bin?url';
import pptxStateURL from './fixtures/pptx-checkpoint.bin?url';
import xlsxStateURL from './fixtures/xlsx-checkpoint.bin?url';
import { biologyOfficeFixtures } from './officeFixtures';
import { LAST_SCENARIO } from './scenarios';

export const scenarioWorkspace = 'ws_scenarios';
export const scenarioNote = 'mock-scenario-note';
export const scenarioText = 'mock-scenario-text';
export const scenarioQuiz = 'mock-scenario-quiz';
export const scenarioCards = 'mock-scenario-cards';
export const scenarioPath = `/workspaces/${scenarioWorkspace}`;
export const scenarioMarker = 'My unsaved scenario edit.';
export const scenarioSavedMarker = 'My saved scenario edit.';
const office = {
  docx: { kind: 'doc', sourceURL: docxURL, stateURL: docxStateURL },
  pptx: { kind: 'slides', sourceURL: pptxURL, stateURL: pptxStateURL },
  xlsx: { kind: 'sheet', sourceURL: xlsxURL, stateURL: xlsxStateURL },
} as const;
type OfficeFormat = keyof typeof office;
const accountObjects = [
  db.user,
  db.accountStatus,
  db.notificationPrefs,
  db.userThinking,
];
let accountSnapshot: typeof accountObjects | null = null;
let notificationSnapshot: typeof db.notifications | null = null;
const sourceSeeds = new Map<
  string,
  {
    epoch: number;
    state?: Uint8Array;
    format: SourceSession['format'];
    sourceURL: string;
  }
>();

export function seedScenarioFixtures() {
  if (db.workspaces.some((workspace) => workspace.id === scenarioWorkspace))
    return;
  db.workspaces.push({
    ...structuredClone(db.workspaces[0]),
    chapterCount: 0,
    cover: undefined,
    fileCount: 5,
    id: scenarioWorkspace,
    name: 'User scenarios',
    tags: [],
  });
  db.materials.push(
    db.makeMaterial({
      ...structuredClone(
        db.materials.find((material) => material.kind === 'note')!
      ),
      chapterId: null,
      content: createMaterialDocument([
        {
          children: [{ text: 'A note for trying application errors.' }],
          type: 'p',
        },
      ]),
      id: scenarioNote,
      title: 'Scenario note',
      workspaceId: scenarioWorkspace,
      workspaceName: 'User scenarios',
    })
  );
  const question: Question = {
    id: 'mock-scenario-question',
    labels: 'letters',
    layout: 'paper',
    level: 'recall' as const,
    parts: [
      {
        answer: {
          accepted: ['The basic unit of life.'],
          hints: [],
          type: 'open',
        },
        blocks: [{ text: 'What is a cell?', type: 'text' }],
        id: 'mock-scenario-question:part',
        marks: 1,
        markscheme: [{ marks: 1, text: 'Identifies the basic unit of life.' }],
        solution: [],
      },
    ],
    stem: [],
  };
  for (const [kind, id, content] of [
    [
      'quiz',
      scenarioQuiz,
      quizNode(
        {
          questions: [{ ...question, id: 'mock-scenario-question' }],
        },
        scenarioQuiz
      ),
    ],
    [
      'flashcards',
      scenarioCards,
      flashcardsNode(
        [
          {
            back: 'The basic unit of life.',
            front: 'What is a cell?',
            id: 'mock-scenario-card',
          },
        ],
        scenarioCards
      ),
    ],
  ] as const) {
    db.materials.push(
      db.makeMaterial({
        ...structuredClone(
          db.materials.find((material) => material.kind === kind)!
        ),
        chapterId: null,
        content: createMaterialDocument([content]),
        id,
        title: `Scenario ${kind}`,
        workspaceId: scenarioWorkspace,
        workspaceName: 'User scenarios',
      })
    );
  }
  db.flashcardCards['mock-scenario-card'] = { materialId: scenarioCards };
  db.tasks.push({
    ...structuredClone(db.tasks[0]),
    id: 'mock-scenario-task',
    title: 'Scenario task',
  });
  const textURL = db.textUrl('A source for trying application errors.\n');
  // Scenario files take f_2's shape but not its opening-text preview.
  const { preview, ...template } = db.files.find((file) => file.id === 'f_2')!;
  for (const [id, name, kind, url] of [
    [scenarioText, 'Scenario source.txt', 'txt', textURL],
    ['mock-scenario-pdf', 'Scenario annotations.pdf', 'pdf', pdfURL],
    ...Object.entries(office).map(([format, fixture]) => [
      `mock-scenario-${format}`,
      `Scenario document.${format}`,
      fixture.kind,
      fixture.sourceURL,
    ]),
  ]) {
    db.files.push({
      ...structuredClone(template),
      chapterId: null,
      id,
      indexed: true,
      kind: kind as SourceFile['kind'],
      name,
      status: 'ready',
      workspaceId: scenarioWorkspace,
    });
    db.fileLinks[id] = { url };
  }
  const archived = {
    ...structuredClone(template),
    chapterId: null,
    id: 'mock-scenario-trash',
    name: 'Scenario archived file',
    workspaceId: scenarioWorkspace,
  };
  db.trash.unshift({
    file: archived,
    item: {
      // A source-file row; the bin also holds material rows.
      ...structuredClone(db.trash.find((entry) => entry.file)!.item),
      episodeId: 'mock-scenario-trash-episode',
      id: archived.id,
      preview: undefined,
      thumbnailUrl: undefined,
      title: archived.name,
      trashedAt: new Date().toISOString(),
      workspaceId: scenarioWorkspace,
      workspaceName: 'User scenarios',
    },
  });
  db.fileLinks[archived.id] = { url: textURL };
  const epoch = Number(
    (typeof sessionStorage === 'undefined'
      ? null
      : sessionStorage.getItem(`capy.scenario.epoch.${scenarioText}`)) ?? 1
  );
  sourceSeeds.set(scenarioText, {
    epoch,
    format: 'text',
    sourceURL:
      epoch === 1
        ? textURL
        : db.textUrl('The current source has been replaced.\n'),
  });
}

async function prepareOfficeSource(
  fileId: string,
  format: OfficeFormat,
  fixture: { sourceURL: string; stateURL: string },
  signal: AbortSignal
) {
  const response = await fetch(fixture.stateURL, { signal });
  if (!response.ok)
    throw new Error(`Office fixture state: HTTP ${response.status}`);
  const state = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  sourceSeeds.set(fileId, {
    epoch: 1,
    format,
    sourceURL: fixture.sourceURL,
    state,
  });
}

/** The Office engine's starters, which the blank file route stores, with
 * their room states (scripts/dev/seed-scenario-office.ts). */
export const blankOffice = {
  docx: { sourceURL: blankDocxURL, stateURL: blankDocxStateURL },
  xlsx: { sourceURL: blankXlsxURL, stateURL: blankXlsxStateURL },
};

/** A created blank file opens on its starter's room state. */
export function prepareBlankOffice(fileId: string, format: 'docx' | 'xlsx') {
  return prepareOfficeSource(
    fileId,
    format,
    blankOffice[format],
    new AbortController().signal
  );
}

/** An Office file the mock upload stored opens to view from its own bytes,
 * as a file without saved changes does (the image compression e2e). */
export function seedUploadedOffice(
  fileId: string,
  format: OfficeFormat,
  sourceURL: string
) {
  sourceSeeds.set(fileId, { epoch: 1, format, sourceURL });
}

export function prepareScenarioOffice(
  format: OfficeFormat,
  signal: AbortSignal
) {
  return prepareOfficeSource(
    `mock-scenario-${format}`,
    format,
    office[format],
    signal
  );
}

/** A card the mock marks older than its saved document (Go's
 * `thumbnailStale`), set in sessionStorage by the capture e2e; a capture of
 * the file clears it. */
const thumbnailStaleKey = (fileId: string) =>
  `capy.mock.thumbnailStale.${fileId}`;

/** An e2e test's growth budget for one file's edit sessions. */
const growthBudgetKey = (fileId: string) =>
  `capy.mock.growthBudgetBytes.${fileId}`;

function mockGrowthBudget(fileId: string) {
  return Number(
    (typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(growthBudgetKey(fileId))) ||
      29 * 1024 ** 2
  );
}

/** A view read's `atSizeLimit`: the test set the file's budget to 0. */
export function mockAtSizeLimit(fileId: string) {
  return mockGrowthBudget(fileId) === 0 || undefined;
}

export function clearMockThumbnailStale(fileId: string) {
  if (typeof sessionStorage !== 'undefined')
    sessionStorage.removeItem(thumbnailStaleKey(fileId));
}

export async function scenarioSourceSession(
  fileId: string
): Promise<SourceSession | null> {
  const biologyFixture = biologyOfficeFixtures.find(
    (fixture) => fixture.id === fileId
  );
  if (!sourceSeeds.has(fileId) && biologyFixture)
    await prepareOfficeSource(
      fileId,
      biologyFixture.format,
      biologyFixture,
      new AbortController().signal
    );
  const format = fileId.replace('mock-scenario-', '');
  if (!sourceSeeds.has(fileId) && format in office)
    await prepareScenarioOffice(
      format as OfficeFormat,
      new AbortController().signal
    );
  const seed = sourceSeeds.get(fileId);
  if (!seed) return null;
  const file = db.files.find((item) => item.id === fileId)!;
  const text =
    seed.format === 'text'
      ? decodeURIComponent(seed.sourceURL.split(',')[1])
      : '';
  const room = sourceRoom(fileId, seed.epoch, text, seed.state, seed.format);
  return {
    access: 'write',
    atSizeLimit: mockAtSizeLimit(fileId),
    baseRevision: file.revision,
    baseSourceSHA256: `scenario-${fileId}-${seed.epoch}`,
    checkpoint: room.version,
    epoch: seed.epoch,
    fileId,
    format: seed.format,
    // A small file's room under the 30 MiB export cap, less the margin,
    // unless a test set one.
    growthBudgetBytes: mockGrowthBudget(fileId),
    // The Free cap, as the mock materials carry.
    imageMaxBytes:
      seed.format === 'text' ? undefined : PLAN_LIMITS.free.imageMaxBytes,
    indexedCheckpoint: 0,
    netTokens: 0,
    room: sourceRoomName(fileId, seed.epoch),
    sourceIdentity: fileId,
    sourceURL: seed.sourceURL,
    state: sourceRoomState(room),
    stateSeedSHA256: null,
    thumbnailStale:
      seed.format !== 'text' &&
      typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(thumbnailStaleKey(fileId)) === 'true'
        ? true
        : undefined,
    workspaceId: file.workspaceId,
  };
}

export function advanceScenarioSource(fileId: string) {
  const seed = sourceSeeds.get(fileId);
  if (!seed) throw new Error('Scenario source is not open');
  seed.epoch++;
  sessionStorage.setItem(`capy.scenario.epoch.${fileId}`, String(seed.epoch));
  if (seed.format === 'text')
    seed.sourceURL = db.textUrl('The current source has been replaced.\n');
  db.fileLinks[fileId] = { url: seed.sourceURL };
  return seed.epoch;
}

export async function resetScenarioFixtures(captureAccount: boolean) {
  resetScenarioRooms();
  if (accountSnapshot)
    accountObjects.forEach((object, index) => {
      for (const key of Object.keys(object))
        Reflect.deleteProperty(object, key);
      Object.assign(object, accountSnapshot![index]);
    });
  if (notificationSnapshot)
    db.notifications.splice(
      0,
      db.notifications.length,
      ...notificationSnapshot
    );
  accountSnapshot = captureAccount ? structuredClone(accountObjects) : null;
  notificationSnapshot = captureAccount
    ? structuredClone(db.notifications)
    : null;
  const { resetScenarioHandlerState } = await import('./handlers');
  resetScenarioHandlerState(scenarioWorkspace);
  const conversations = new Set(
    db.conversations
      .filter((row) => row.workspaceId === scenarioWorkspace)
      .map((row) => row.id)
  );
  for (let i = db.chatMessages.length - 1; i >= 0; i--)
    if (conversations.has(db.chatMessages[i].conversationId))
      db.chatMessages.splice(i, 1);
  for (let i = db.attempts.length - 1; i >= 0; i--)
    if (db.attempts[i].materialId === scenarioQuiz) db.attempts.splice(i, 1);
  for (let i = db.tasks.length - 1; i >= 0; i--)
    if (db.tasks[i].id.startsWith('mock-scenario-')) db.tasks.splice(i, 1);
  for (let i = db.trash.length - 1; i >= 0; i--)
    if (db.trash[i].item.workspaceId === scenarioWorkspace)
      db.trash.splice(i, 1);
  // Include deleted fixtures: their drafts and links can outlive the file row.
  const fileIds = new Set([
    ...[...sourceSeeds.keys()].filter((id) => id.startsWith('mock-scenario-')),
    ...Object.keys(db.fileLinks).filter((id) =>
      id.startsWith('mock-scenario-')
    ),
    ...db.files
      .filter((row) => row.workspaceId === scenarioWorkspace)
      .map((row) => row.id),
  ]);
  for (const fileId of fileIds) {
    await deleteDocumentDrafts(draftKey(db.user.id, 'file', fileId));
    delete db.fileLinks[fileId];
    sessionStorage.removeItem(`capy.scenario.epoch.${fileId}`);
  }
  for (const rows of [db.files, db.materials, db.chapters, db.conversations]) {
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i].workspaceId === scenarioWorkspace) rows.splice(i, 1);
  }
  const index = db.workspaces.findIndex((row) => row.id === scenarioWorkspace);
  if (index >= 0) db.workspaces.splice(index, 1);
  sourceSeeds.clear();
  seedScenarioFixtures();
}

seedScenarioFixtures();
// Rehydrate only the permission state, never the edit/navigation journey.
if (
  typeof sessionStorage !== 'undefined' &&
  sessionStorage.getItem(LAST_SCENARIO) === 'note-permission-lost'
) {
  const note = db.materials.find((row) => row.id === scenarioNote)!;
  note.capabilities = {
    ...note.capabilities,
    canEdit: false,
    canEditContent: false,
  };
}
