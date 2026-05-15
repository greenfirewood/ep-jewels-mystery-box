/***********************************************************************************************************************
* This file is auto-generated. If you have an issue, please create a GitHub issue.                                     *
***********************************************************************************************************************/
import { Base } from '../../base';
import { ResourcePath, ResourceNames } from '../../types';
import { Session } from '../../../lib/session/session';
import { ApiVersion } from '../../../lib/types';
import { Transaction } from './transaction';
import { Checkout } from './checkout';
interface FindArgs {
    session: Session;
    id: number | string;
    checkout_id?: number | string | null;
}
export declare class Payment extends Base {
    static apiVersion: ApiVersion;
    protected static hasOne: {
        [key: string]: typeof Base;
    };
    protected static hasMany: {
        [key: string]: typeof Base;
    };
    protected static paths: ResourcePath[];
    protected static resourceNames: ResourceNames[];
    static find({ session, id, checkout_id }: FindArgs): Promise<Payment | null>;
    checkout: Checkout | null | {
        [key: string]: any;
    };
    credit_card: {
        [key: string]: unknown;
    } | null;
    id: string | null;
    next_action: {
        [key: string]: unknown;
    } | null;
    payment_processing_error_message: string | null;
    transaction: Transaction | null | {
        [key: string]: any;
    };
    unique_token: string | null;
}
export {};
//# sourceMappingURL=payment.d.ts.map