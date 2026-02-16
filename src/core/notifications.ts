/**
 * Notification dispatcher for Slack and Discord webhooks
 */

import { createLogger } from './logger';

const log = createLogger('notifications');

export interface NotificationConfig {
  slackWebhook?: string;
  discordWebhook?: string;
}

export interface NotificationPayload {
  type: 'scan_complete' | 'high_priority_pr' | 'spam_detected';
  repo: string;
  message: string;
  prNumber?: number;
  score?: number;
  url?: string;
}

/**
 * Emoji mapping for notification types
 */
const EMOJI_MAP: Record<NotificationPayload['type'], string> = {
  scan_complete: '✅',
  high_priority_pr: '⭐',
  spam_detected: '⚠️',
};

/**
 * Color mapping for Discord embeds (hex colors)
 */
const COLOR_MAP: Record<NotificationPayload['type'], number> = {
  scan_complete: 0x00ff00,    // Green
  high_priority_pr: 0xffaa00, // Yellow
  spam_detected: 0xff0000,    // Red
};

export class NotificationDispatcher {
  private readonly config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  /**
   * Returns true if at least one webhook is configured
   */
  get hasChannels(): boolean {
    return !!(this.config.slackWebhook || this.config.discordWebhook);
  }

  /**
   * Send notification to all configured channels in parallel
   * Never throws — logs errors and continues
   */
  async send(payload: NotificationPayload): Promise<void> {
    if (!this.hasChannels) {
      return;
    }

    const promises: Promise<void>[] = [];

    if (this.config.slackWebhook) {
      promises.push(this.sendSlack(payload));
    }

    if (this.config.discordWebhook) {
      promises.push(this.sendDiscord(payload));
    }

    const results = await Promise.allSettled(promises);

    // Log any errors but don't throw
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const channel = index === 0 ? 'Slack' : 'Discord';
        log.error({ channel, err: result.reason }, 'Failed to send notification');
      }
    });
  }

  /**
   * Send notification to Slack using Block Kit
   */
  private async sendSlack(payload: NotificationPayload): Promise<void> {
    if (!this.config.slackWebhook) return;

    const emoji = EMOJI_MAP[payload.type];
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${payload.repo}*\n${payload.message}`,
        },
      },
    ];

    // Add fields for PR number and score if provided
    const fields: any[] = [];
    if (payload.prNumber !== undefined) {
      fields.push({
        type: 'mrkdwn',
        text: `*PR:*\n#${payload.prNumber}`,
      });
    }
    if (payload.score !== undefined) {
      fields.push({
        type: 'mrkdwn',
        text: `*Score:*\n${payload.score}`,
      });
    }

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields,
      });
    }

    // Add button to view PR if URL provided
    if (payload.url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View PR',
            },
            url: payload.url,
          },
        ],
      });
    }

    try {
      const response = await fetch(this.config.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      log.error({ err: error }, 'Slack notification failed');
      throw error;
    }
  }

  /**
   * Send notification to Discord using embeds
   */
  private async sendDiscord(payload: NotificationPayload): Promise<void> {
    if (!this.config.discordWebhook) return;

    const color = COLOR_MAP[payload.type];
    const fields: any[] = [];

    if (payload.prNumber !== undefined) {
      fields.push({
        name: 'PR',
        value: `#${payload.prNumber}`,
        inline: true,
      });
    }

    if (payload.score !== undefined) {
      fields.push({
        name: 'Score',
        value: String(payload.score),
        inline: true,
      });
    }

    const embed: any = {
      title: payload.repo,
      description: payload.message,
      color,
      fields,
      timestamp: new Date().toISOString(),
    };

    if (payload.url) {
      embed.url = payload.url;
    }

    try {
      const response = await fetch(this.config.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      log.error({ err: error }, 'Discord notification failed');
      throw error;
    }
  }
}
