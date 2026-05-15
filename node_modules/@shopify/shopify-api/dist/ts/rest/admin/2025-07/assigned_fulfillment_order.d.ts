/***********************************************************************************************************************
* This file is auto-generated. If you have an issue, please create a GitHub issue.                                     *
***********************************************************************************************************************/
import { Base, FindAllResponse } from '../../base';
import { ResourcePath, ResourceNames } from '../../types';
import { Session } from '../../../lib/session/session';
import { ApiVersion } from '../../../lib/types';
interface AllArgs {
    [key: string]: unknown;
    session: Session;
    assignment_status?: unknown;
    location_ids?: unknown[] | number | string | null;
}
export declare class AssignedFulfillmentOrder extends Base {
    static apiVersion: ApiVersion;
    protected static hasOne: {
        [key: string]: typeof Base;
    };
    protected static hasMany: {
        [key: string]: typeof Base;
    };
    protected static paths: ResourcePath[];
    protected static resourceNames: ResourceNames[];
    static all({ session, assignment_status, location_ids, ...otherArgs }: AllArgs): Promise<FindAllResponse<AssignedFulfillmentOrder>>;
    assigned_location_id: string | null;
    destination: {
        [key: string]: unknown;
    } | null;
    id: string | null;
    line_items: {
        [key: string]: unknown;
    }[] | null;
    order_id: string | null;
    request_status: string | null;
    shop_id: string | null;
    status: string | null;
}
export {};
//# sourceMappingURL=assigned_fulfillment_order.d.ts.map