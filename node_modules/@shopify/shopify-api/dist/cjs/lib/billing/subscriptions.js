'use strict';

var error = require('../error.js');
var client = require('../clients/admin/graphql/client.js');
require('@shopify/admin-api-client');
require('lossless-json');
require('../types.js');
require('compare-versions');
var types = require('./types.js');
var utils = require('./utils.js');

const SUBSCRIPTION_QUERY = `
${types.APP_SUBSCRIPTION_FRAGMENT}
query appSubscription {
  currentAppInstallation {
    activeSubscriptions {
      ...AppSubscriptionFragment
    }
  }
}
`;
function subscriptions(config) {
    return async function ({ session, }) {
        if (!config.future?.unstable_managedPricingSupport && !config.billing) {
            throw new error.BillingError({
                message: 'Attempted to look for purchases without billing configs',
                errorData: [],
            });
        }
        const GraphqlClient = client.graphqlClientClass({ config });
        const client$1 = new GraphqlClient({ session });
        const response = await client$1.request(SUBSCRIPTION_QUERY);
        if (!response.data?.currentAppInstallation?.activeSubscriptions) {
            return { activeSubscriptions: [] };
        }
        const activeSubscriptions = response.data.currentAppInstallation.activeSubscriptions;
        activeSubscriptions.forEach((subscription) => {
            if (subscription.lineItems) {
                subscription.lineItems = utils.convertLineItems(subscription.lineItems);
            }
        });
        return {
            activeSubscriptions,
        };
    };
}

exports.subscriptions = subscriptions;
//# sourceMappingURL=subscriptions.js.map
