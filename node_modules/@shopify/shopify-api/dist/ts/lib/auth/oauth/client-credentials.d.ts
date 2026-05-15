import { ConfigInterface } from '../../base-types';
import { Session } from '../../session/session';
export interface ClientCredentialsParams {
    shop: string;
}
export type ClientCredentials = (params: ClientCredentialsParams) => Promise<{
    session: Session;
}>;
export declare function clientCredentials(config: ConfigInterface): ClientCredentials;
//# sourceMappingURL=client-credentials.d.ts.map