import { describe, expect, it } from 'vitest';
import { createKnowledgeSourceRequest, phonePlanRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { findSource, kbName, sourceFilename, sourceTitle } from './knowledge-sync.worker';
import { decodeSource } from './knowledge.service';

const ROW = { id: 'abcdef12-3456-4789-8abc-def123456789', name: 'Opening hours.pdf', type: 'file', url: null, contentType: 'application/pdf' };

describe('createKnowledgeSourceRequest', () => {
  it('accepts the three kinds and rejects the rest', () => {
    expect(createKnowledgeSourceRequest.safeParse({ type: 'url', url: 'https://example.com/faq' }).success).toBe(true);
    expect(createKnowledgeSourceRequest.safeParse({ type: 'text', name: 'Hours', text: 'Open 9–5.' }).success).toBe(true);
    expect(createKnowledgeSourceRequest.safeParse({ type: 'file', name: 'a.pdf', content_type: 'application/pdf', content_base64: 'JVBERi0=' }).success).toBe(true);
    expect(createKnowledgeSourceRequest.safeParse({ type: 'url', url: 'ftp://example.com' }).success).toBe(false);
    expect(createKnowledgeSourceRequest.safeParse({ type: 'file', name: 'a.exe', content_type: 'application/x-msdownload', content_base64: 'AA==' }).success).toBe(false);
    expect(createKnowledgeSourceRequest.safeParse({ type: 'text', name: 'x', text: '' }).success).toBe(false);
  });
});

describe('decodeSource', () => {
  it('refuses private and credentialed URLs', () => {
    for (const url of ['http://localhost/x', 'http://127.0.0.1:4000/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://intranet/', 'https://user:pw@example.com/']) {
      expect(() => decodeSource({ type: 'url', url }), url).toThrow(AppError);
    }
    expect(decodeSource({ type: 'url', url: 'https://example.com/faq' })).toMatchObject({ name: 'example.com/faq', url: 'https://example.com/faq' });
  });

  it('decodes base64, measures it and refuses an empty or oversized file', () => {
    const decoded = decodeSource({ type: 'file', name: 'hours.pdf', content_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.4 hello').toString('base64') });
    expect(decoded.sizeBytes).toBe(14);
    expect(decoded.payload?.toString()).toBe('%PDF-1.4 hello');
    expect(() => decodeSource({ type: 'file', name: 'x', content_type: 'text/plain', content_base64: '====' })).toThrow(/empty/);
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    expect(() => decodeSource({ type: 'file', name: 'x', content_type: 'text/plain', content_base64: big })).toThrow(/up to 20 MB/);
  });
});

describe('source identity on the platform', () => {
  it('names the KB after the agent and embeds the row id in titles and filenames', () => {
    expect(kbName('abcdef12-3456-4789-8abc-def123456789')).toBe('kb-abcdef1234564789' + '8abc');
    expect(kbName('abcdef12-3456-4789-8abc-def123456789').length).toBeLessThanOrEqual(40 - 'staging-'.length);
    expect(sourceTitle(ROW)).toBe('Opening hours.pdf [abcdef12]');
    expect(sourceFilename(ROW)).toBe('abcdef12-Opening-hours.pdf');
  });

  it('finds our source in a listing and nothing else', () => {
    const kb = {
      knowledge_base_id: 'kb',
      knowledge_base_name: 'x',
      status: 'complete' as const,
      knowledge_base_sources: [
        { type: 'document' as const, source_id: 's1', filename: 'abcdef12-Opening-hours.pdf', file_url: '', file_size: 1 },
        { type: 'text' as const, source_id: 's2', title: 'Parking [11111111]', content_url: '' },
        { type: 'url' as const, source_id: 's3', url: 'https://Example.com/faq/' },
      ],
    };
    expect(findSource(kb, ROW)).toBe('s1');
    expect(findSource(kb, { id: '11111111-0000-4000-8000-000000000000', name: 'Parking', type: 'text', url: null, contentType: null })).toBe('s2');
    expect(findSource(kb, { id: 'x', name: 'faq', type: 'url', url: 'https://example.com/faq', contentType: null })).toBe('s3');
    expect(findSource(kb, { id: 'zzzzzzzz-0000-4000-8000-000000000000', name: 'Other', type: 'text', url: null, contentType: null })).toBeNull();
  });
});

describe('phonePlanRequest', () => {
  it('validates the fields of each option', () => {
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'CA', area_code: '450' }).success).toBe(true);
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'FR' }).success).toBe(false);
    expect(phonePlanRequest.safeParse({ option: 'new', country: 'US', area_code: '12' }).success).toBe(false);
    expect(phonePlanRequest.safeParse({ option: 'forward', country: 'CA', existing_number: '+15145550100', carrier: 'bell' }).success).toBe(true);
    expect(phonePlanRequest.safeParse({ option: 'forward', country: 'CA', existing_number: '514-555-0100' }).success).toBe(false);
    expect(phonePlanRequest.safeParse({ option: 'sip', sip: { number: '+14505550123', host: 'sip.example.com', username: 'u', password: 'p' } }).success).toBe(true);
    expect(phonePlanRequest.safeParse({ option: 'sip', sip: { number: '+14505550123', host: 'not a host!' } }).success).toBe(false);
    expect(phonePlanRequest.safeParse({ option: 'sip', sip: { number: '+14505550123', host: 'sip:pbx.example.com:5060' } }).success).toBe(true);
    expect(phonePlanRequest.safeParse({ option: 'port' }).success).toBe(true); // valid shape; the service refuses it
  });
});
