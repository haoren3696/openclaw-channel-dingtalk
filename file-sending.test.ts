import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { uploadMedia, sendFileMessage, sendBySession } from './channel';
import type { DingTalkConfig } from './types';

vi.mock('axios');
vi.mock('node:fs');
vi.mock('form-data');

describe('DingTalk File Sending', () => {
  const mockConfig: DingTalkConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    robotCode: 'test-robot-code',
    agentId: 'test-agent-id',
  };

  const mockToken = 'test-access-token';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.post).mockResolvedValue({
      data: { mediaId: 'test-media-id' },
      status: 200,
      statusText: 'OK',
      headers: {},
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any);
    vi.mocked(fs.createReadStream).mockReturnValue({} as any);
    vi.mocked(path.basename).mockReturnValue('test-file.pdf');
  });

  describe('uploadMedia', () => {
    it('should upload a file successfully', async () => {
      const mockFormData = {
        append: vi.fn(),
        getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
      };
      vi.mocked(FormData).mockImplementation(() => mockFormData as any);

      const result = await uploadMedia(mockConfig, '/path/to/file.pdf', 'file');

      expect(result).toEqual({
        mediaId: 'test-media-id',
        type: 'file',
        createdAt: expect.any(String),
      });
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/media/upload',
        expect.any(FormData),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-acs-dingtalk-access-token': expect.any(String),
            'Content-Type': 'multipart/form-data',
          }),
        })
      );
    });

    it('should return null if file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await uploadMedia(mockConfig, '/path/to/nonexistent.pdf', 'file');

      expect(result).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should return null on upload error', async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error('Upload failed'));

      const result = await uploadMedia(mockConfig, '/path/to/file.pdf', 'file');

      expect(result).toBeNull();
    });
  });

  describe('sendFileMessage', () => {
    it('should send a file message to group', async () => {
      const mockFormData = {
        append: vi.fn(),
        getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
      };
      vi.mocked(FormData).mockImplementation(() => mockFormData as any);

      const result = await sendFileMessage(mockConfig, 'cid-group-id', '/path/to/file.pdf');

      expect(result).toBeDefined();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
        expect.objectContaining({
          robotCode: mockConfig.robotCode,
          msgKey: 'sampleFile',
          openConversationId: 'cid-group-id',
        }),
        expect.any(Object)
      );
    });

    it('should send a file message to user', async () => {
      const mockFormData = {
        append: vi.fn(),
        getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
      };
      vi.mocked(FormData).mockImplementation(() => mockFormData as any);

      const result = await sendFileMessage(mockConfig, 'user-id', '/path/to/file.pdf');

      expect(result).toBeDefined();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
        expect.objectContaining({
          robotCode: mockConfig.robotCode,
          userIds: ['user-id'],
        }),
        expect.any(Object)
      );
    });
  });

  describe('sendBySession with file', () => {
    it('should send a file via session webhook', async () => {
      const mockFormData = {
        append: vi.fn(),
        getHeaders: vi.fn(() => ({ 'content-type': 'multipart/form-data' })),
      };
      vi.mocked(FormData).mockImplementation(() => mockFormData as any);

      const result = await sendBySession(mockConfig, 'https://session-webhook-url', 'File sent', '/path/to/file.pdf');

      expect(result).toBeDefined();
      expect(axios.post).toHaveBeenCalledWith(
        'https://session-webhook-url',
        expect.objectContaining({
          msgtype: 'file',
          file: {
            fileName: 'test-file.pdf',
            mediaId: 'test-media-id',
          },
        }),
        expect.any(Object)
      );
    });
  });
});
