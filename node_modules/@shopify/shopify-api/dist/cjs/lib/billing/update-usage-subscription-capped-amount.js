'use strict';

var error = require('../error.js');
var client = require('../clients/admin/graphql/client.js');
require('@shopify/admin-api-client');
require('lossless-json');
require('../types.js');
require('compare-versions');
var types = require('./types.js');
var utils = require('./utils.js');

const UPDATE_USAGE_CAPPED_AMOUNT_MUTATION = `
${types.APP_SUBSCRIPTION_FRAGMENT}
mutation appSubscriptionLineItemUpdate($cappedAmount: MoneyInput!, $id: ID!) {
  appSubscriptionLineItemUpdate(cappedAmount: $cappedAmount, id: $id) {
    userErrors {
      field
      message
    }
    confirmationUrl
    appSubscription {
      ...AppSubscriptionFragment
    }
  }
}
`;
function updateUsageCappedAmount(config) {
    return async function updateUsageCappedAmount(params) {
        if (!config.billing) {
            throw new error.BillingError({
                message: 'Attempted to update line item without billing configs',
                errorData: [],
            });
        }
        const { session, subscriptionLineItemId, cappedAmount: { amount, currencyCode }, } = params;
        const GraphqlClient = client.graphqlClientClass({ config });
        const client$1 = new GraphqlClient({ session });
        try {
            const response = await client$1.request(UPDATE_USAGE_CAPPED_AMOUNT_MUTATION, {
                variables: {
                    id: subscriptionLineItemId,
                    cappedAmount: {
                        amount,
                        currencyCode,
                    },
                },
            });
            if (response.data?.appSubscriptionLineItemUpdate?.userErrors.length) {
                throw new error.BillingError({
                    message: 'Error while updating usage subscription capped amount',
                    errorData: response.data?.appSubscriptionLineItemUpdate?.userErrors,
                });
            }
            const appSubscription = response.data?.appSubscriptionLineItemUpdate?.appSubscription;
            if (appSubscription && appSubscription.lineItems) {
                appSubscription.lineItems = utils.convertLineItems(appSubscription.lineItems);
            }
            return {
                confirmationUrl: response.data?.appSubscriptionLineItemUpdate?.confirmationUrl,
                appSubscription,
            };
        }
        catch (error$1) {
            if (error$1 instanceof error.GraphqlQueryError) {
                throw new error.BillingError({
                    message: error$1.message,
                    errorData: error$1.response?.errors,
                });
            }
            throw error$1;
        }
    };
}

exports.updateUsageCappedAmount = updateUsageCappedAmount;
//# sourceMappingURL=update-usage-subscription-capped-amount.js.map
