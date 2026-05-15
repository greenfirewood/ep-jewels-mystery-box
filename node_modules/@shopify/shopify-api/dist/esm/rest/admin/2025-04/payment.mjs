import { Base } from '../../base.mjs';
import { ApiVersion } from '../../../lib/types.mjs';
import { Transaction } from './transaction.mjs';
import { Checkout } from './checkout.mjs';

/***********************************************************************************************************************
* This file is auto-generated. If you have an issue, please create a GitHub issue.                                     *
***********************************************************************************************************************/
class Payment extends Base {
    static apiVersion = ApiVersion.April25;
    static hasOne = {
        "transaction": Transaction,
        "checkout": Checkout
    };
    static hasMany = {};
    static paths = [
        { "http_method": "get", "operation": "get", "ids": ["checkout_id", "id"], "path": "checkouts/<checkout_id>/payments/<id>.json" },
        { "http_method": "post", "operation": "post", "ids": ["checkout_id"], "path": "checkouts/<checkout_id>/payments.json" }
    ];
    static resourceNames = [
        {
            "singular": "payment",
            "plural": "payments"
        }
    ];
    static async find({ session, id, checkout_id = null }) {
        const result = await this.baseFind({
            session: session,
            urlIds: { "id": id, "checkout_id": checkout_id },
            params: {},
        });
        return result.data ? result.data[0] : null;
    }
    checkout;
    credit_card;
    id;
    next_action;
    payment_processing_error_message;
    transaction;
    unique_token;
}

export { Payment };
//# sourceMappingURL=payment.mjs.map
