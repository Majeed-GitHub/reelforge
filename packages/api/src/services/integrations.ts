import type { AuthContext } from '../auth.ts';

/**
 * Integrations surface. Director syncs published articles to Zendesk; the
 * self-hosted adapter is a stub you can point anywhere. Reported by
 * `list_integrations` (MCP) so an agent can discover what exists.
 */
export type IntegrationView = {
  id: string;
  name: string;
  category: 'helpdesk' | 'chat' | 'analytics';
  configured: boolean;
  docs: string;
  env: string[];
  description: string;
};

export function listIntegrations(_auth: AuthContext): IntegrationView[] {
  const flag = (name: string) => Boolean((process.env[name] ?? '').trim());
  return [
    {
      id: 'zendesk',
      name: 'Zendesk',
      category: 'helpdesk',
      configured: flag('ZENDESK_SUBDOMAIN') && flag('ZENDESK_API_TOKEN'),
      docs: 'https://developer.zendesk.com/api-reference/help-center/',
      env: ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN'],
      description: 'Publishing a help-centre article upserts it into Zendesk Help Center.'
    },
    {
      id: 'intercom',
      name: 'Intercom',
      category: 'chat',
      configured: flag('INTERCOM_ACCESS_TOKEN'),
      docs: 'https://developers.intercom.com/',
      env: ['INTERCOM_ACCESS_TOKEN'],
      description: 'Publishes guides into Intercom articles for in-app help.'
    },
    {
      id: 'zapier',
      name: 'Zapier / webhooks',
      category: 'analytics',
      configured: flag('REELFORGE_WEBHOOK_URL'),
      docs: 'https://zapier.com/',
      env: ['REELFORGE_WEBHOOK_URL'],
      description: 'Posts a JSON event when a demo completes, an article publishes, or a guide goes live.'
    }
  ];
}