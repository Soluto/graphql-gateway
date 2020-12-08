import { FastifyRequest } from 'fastify';
import logger from '../logger';
import { Upstream } from '../resource-repository';
import { AuthenticationConfig } from '.';

export async function getAuthHeaders(
  upstream: Upstream,
  authConfig: AuthenticationConfig,
  originalRequest?: Pick<FastifyRequest, 'headers'>
) {
  // Try AD auth
  if (typeof upstream !== 'undefined') {
    const credentials = authConfig.getUpstreamClientCredentialsByAuthority(upstream.auth!.activeDirectory.authority);
    if (typeof credentials !== 'undefined') {
      try {
        const token = await authConfig.activeDirectoryAuth.getToken(
          credentials.activeDirectory.authority,
          credentials.activeDirectory.clientId,
          credentials.activeDirectory.clientSecret,
          upstream.auth!.activeDirectory.resource
        );

        return {
          Authorization: `Bearer ${token}`,
        };
      } catch (ex) {
        logger.error('Failed to authenticate with Active Directory', ex);
        throw ex;
      }
    }
  }

  // If AD auth doesn't apply, pass along the header we got from the request
  const incomingAuthHeader = originalRequest?.headers?.['authorization'];
  if (incomingAuthHeader) {
    return {
      Authorization: incomingAuthHeader as string,
    };
  }

  return;
}
