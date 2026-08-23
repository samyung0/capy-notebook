import { describe, expect, it } from 'vitest';

import { parseGooglePickerConfig } from './googlePicker';
import {
  isAllowedPickerOrigin,
  isPickerConsentBlocked,
  isPickerUserCancelled,
  parsePickedItems,
  pickerHostFromDrive,
  pickerLocale,
  pickerTokenScopes,
  toImportRequest,
} from './onedrivePicker';

describe('pickerHostFromDrive', () => {
  it('uses the consumer picker URL for personal drives', () => {
    expect(
      pickerHostFromDrive({
        driveType: 'personal',
        webUrl: 'https://onedrive.live.com/?id=root',
      })
    ).toEqual({
      kind: 'personal',
      origin: 'https://onedrive.live.com',
      pickerUrl: 'https://onedrive.live.com/picker',
      tokenResource: 'https://onedrive.live.com',
    });
  });

  it('builds FilePicker.aspx from the Graph webUrl origin for work drives', () => {
    expect(
      pickerHostFromDrive({
        driveType: 'business',
        webUrl:
          'https://contoso-my.sharepoint.com/personal/ada_contoso_com/Documents',
      })
    ).toEqual({
      kind: 'work',
      origin: 'https://contoso-my.sharepoint.com',
      pickerUrl:
        'https://contoso-my.sharepoint.com/_layouts/15/FilePicker.aspx',
      tokenResource: 'https://contoso-my.sharepoint.com',
    });
  });

  it('does not use email or http webUrl to choose the host', () => {
    expect(() =>
      pickerHostFromDrive({
        driveType: 'business',
        webUrl: 'http://contoso-my.sharepoint.com',
      })
    ).toThrow('invalid drive webUrl');
  });

  it('treats documentLibrary as a work FilePicker host', () => {
    expect(
      pickerHostFromDrive({
        driveType: 'documentLibrary',
        webUrl: 'https://contoso.sharepoint.com/sites/docs',
      }).pickerUrl
    ).toBe('https://contoso.sharepoint.com/_layouts/15/FilePicker.aspx');
  });
});

describe('picker token scopes', () => {
  it('keeps personal on OneDrive.ReadOnly', () => {
    expect(
      pickerTokenScopes('personal', 'https://contoso-my.sharepoint.com')
    ).toEqual(['OneDrive.ReadOnly']);
  });

  it('mints SharePoint /.default for work resources', () => {
    expect(
      pickerTokenScopes('work', 'https://contoso-my.sharepoint.com/')
    ).toEqual(['https://contoso-my.sharepoint.com/.default']);
  });
});

describe('picker origin check', () => {
  it('accepts only the computed picker origin', () => {
    const host = pickerHostFromDrive({
      driveType: 'business',
      webUrl: 'https://contoso-my.sharepoint.com/personal/ada',
    });
    expect(
      isAllowedPickerOrigin('https://contoso-my.sharepoint.com', host)
    ).toBe(true);
    expect(isAllowedPickerOrigin('https://evil.example', host)).toBe(false);
    expect(isAllowedPickerOrigin('https://onedrive.live.com', host)).toBe(
      false
    );
  });
});

describe('parsePickedItems', () => {
  it('reads id and parentReference.driveId', () => {
    expect(
      parsePickedItems({
        items: [
          { id: 'item1', parentReference: { driveId: 'b!abc' } },
          { id: 'item2' },
          { parentReference: { driveId: 'nope' } },
        ],
      })
    ).toEqual([{ driveId: 'b!abc', id: 'item1' }, { id: 'item2' }]);
  });
});

describe('toImportRequest', () => {
  it('adds driveIds only for Microsoft when a drive id is present', () => {
    expect(
      toImportRequest('microsoft', [
        { driveId: 'b!abc', id: 'item1' },
        { id: 'item2' },
      ])
    ).toEqual({
      chapterId: undefined,
      driveIds: ['b!abc', ''],
      fileIds: ['item1', 'item2'],
      provider: 'microsoft',
    });
    expect(
      toImportRequest('google', [{ driveId: 'ignored', id: 'g1' }])
    ).toEqual({
      chapterId: undefined,
      fileIds: ['g1'],
      provider: 'google',
    });
  });
});

describe('consent errors', () => {
  it('maps admin and consent failures', () => {
    expect(isPickerConsentBlocked({ errorCode: 'consent_required' })).toBe(
      true
    );
    expect(
      isPickerConsentBlocked(new Error('AADSTS65001: admin consent'))
    ).toBe(true);
    expect(isPickerConsentBlocked({ message: 'AADSTS90094' })).toBe(true);
    expect(isPickerConsentBlocked({ errorCode: 'access_denied' })).toBe(true);
    expect(isPickerConsentBlocked(new Error('interaction_required'))).toBe(
      false
    );
    expect(isPickerConsentBlocked(new Error('PICKER_CONSENT'))).toBe(true);
    expect(isPickerUserCancelled({ errorCode: 'user_cancelled' })).toBe(true);
    expect(isPickerConsentBlocked({ errorCode: 'user_cancelled' })).toBe(false);
  });
});

describe('picker locale', () => {
  it('maps paraglide locales to SharePoint LCIDs', () => {
    expect(pickerLocale('en')).toBe('en-us');
    expect(pickerLocale('zh')).toBe('zh-cn');
  });
});

describe('google picker env', () => {
  it('fails closed when key or app id is missing', () => {
    expect(() => parseGooglePickerConfig({ apiKey: 'k' })).toThrow(
      'GOOGLE_PICKER_CONFIG'
    );
    expect(parseGooglePickerConfig({ apiKey: ' k ', appId: ' 1 ' })).toEqual({
      apiKey: 'k',
      appId: '1',
    });
  });
});
