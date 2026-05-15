/***********************************************************************************************************************
* This file is auto-generated. If you have an issue, please create a GitHub issue.                                     *
***********************************************************************************************************************/
import { Base } from '../../base';
import { ResourcePath, ResourceNames } from '../../types';
import { ApiVersion } from '../../../lib/types';
interface AcceptArgs {
    [key: string]: unknown;
    message?: unknown;
    body?: {
        [key: string]: unknown;
    } | null;
}
interface RejectArgs {
    [key: string]: unknown;
    message?: unknown;
    reason?: unknown;
    line_items?: unknown;
    body?: {
        [key: string]: unknown;
    } | null;
}
export declare class FulfillmentRequest extends Base {
    static apiVersion: ApiVersion;
    protected static hasOne: {
        [key: string]: typeof Base;
    };
    protected static hasMany: {
        [key: string]: typeof Base;
    };
    protected static paths: ResourcePath[];
    protected static resourceNames: ResourceNames[];
    accept({ message, body, ...otherArgs }: AcceptArgs): Promise<unknown>;
    reject({ message, reason, line_items, body, ...otherArgs }: RejectArgs): Promise<unknown>;
    fulfillment_order_id: string | null;
    kind: string | null;
    message: string | null;
    request_options: {
        [key: string]: unknown;
    } | null;
    response_data: {
        [key: string]: unknown;
    } | null;
    sent_at: string | null;
}
export {};
//# sourceMappingURL=fulfillment_request.d.ts.map