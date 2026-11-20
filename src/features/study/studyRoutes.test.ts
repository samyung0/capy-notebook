import { expect, it } from 'vitest';
import {
  isStudyTab,
  parseStudySearch,
  studyLink,
  studyTabPage,
} from './studyRoutes';

it("names Study's tabs, Topics being the staff's Overview", () => {
  expect(
    ['summary', 'topics', 'practice', 'bank', 'history'].every(isStudyTab)
  ).toBe(true);
  expect(studyTabPage('topics')).toBe('summary');
  expect(studyTabPage('practice')).toBe('practice');
  expect(studyLink('ws1', 'history', { status: 'open' })).toEqual({
    params: { tab: 'history', workspaceId: 'ws1' },
    search: { status: 'open' },
    to: '/workspaces/$workspaceId/study/$tab',
  });
});

it("keeps Practice's session or result and a member's profile from the URL", () => {
  expect(
    parseStudySearch({
      group: 'topic',
      reviewMode: 'fading',
      topicId: 't1',
    })
  ).toMatchObject({ group: 'topic', reviewMode: 'fading', topicId: 't1' });
  expect(parseStudySearch({ review: 's1' })).toMatchObject({ review: 's1' });
  expect(parseStudySearch({ member: 'u1' })).toMatchObject({ member: 'u1' });
});
