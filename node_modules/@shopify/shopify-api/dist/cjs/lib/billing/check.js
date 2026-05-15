'use strict';

var client = require('../clients/admin/graphql/client.js');
require('@shopify/admin-api-client');
require('lossless-json');
var error = require('../error.js');
require('../types.js');
require('compare-versions');
var types = require('./types.js');
var utils = require('./utils.js');

function check(config) {
    return async function check(params) {
        if (!config.future?.unstable_managedPricingSupport && !config.billing) {
            throw new error.BillingError({
                message: 'Attempted to look for purchases without billing configs',
                errorData: [],
            });
        }
        const { session, isTest = true, plans } = params;
        const returnObject = params
            .returnObject ?? false;
        const GraphqlClient = client.graphqlClientClass({ config });
        const client$1 = new GraphqlClient({ session });
        const payments = await assessPayments({ client: client$1, isTest, plans });
        if (config.future?.unstable_managedPricingSupport || returnObject) {
            return payments;
        }
        else {
            return payments.hasActivePayment;
        }
    };
}
async function assessPayments({ client, isTest, plans, }) {
    const returnValue = {
        hasActivePayment: false,
        oneTimePurchases: [],
        appSubscriptions: [],
    };
    let installation;
    let endCursor = null;
    do {
        const currentInstallations = await client.request(HAS_PAYMENTS_QUERY, { variables: { endCursor } });
        installation = currentInstallations.data?.currentAppInstallation;
        installation.activeSubscriptions.forEach((subscription) => {
            if (subscriptionMeetsCriteria({ subscription, isTest, plans })) {
                returnValue.hasActivePayment = true;
                if (subscription.lineItems) {
                    subscription.lineItems = utils.convertLineItems(subscription.lineItems);
                }
                returnValue.appSubscriptions.push(subscription);
            }
        });
        installation.oneTimePurchases.edges.forEach(({ node: purchase }) => {
            if (purchaseMeetsCriteria({ purchase, isTest, plans })) {
                returnValue.hasActivePayment = true;
                returnValue.oneTimePurchases.push(purchase);
            }
        });
        endCursor = installation.oneTimePurchases.pageInfo.endCursor;
    } while (installation?.oneTimePurchases.pageInfo.hasNextPage);
    return returnValue;
}
function subscriptionMeetsCriteria({ subscription, isTest, plans, }) {
    return ((typeof plans === 'undefined' || plans.includes(subscription.name)) &&
        (isTest || !subscription.test));
}
function purchaseMeetsCriteria({ purchase, isTest, plans, }) {
    return ((typeof plans === 'undefined' || plans.includes(purchase.name)) &&
        (isTest || !purchase.test) &&
        purchase.status === 'ACTIVE');
}
const HAS_PAYMENTS_QUERY = `
  ${types.APP_SUBSCRIPTION_FRAGMENT}
  query appSubscription($endCursor: String) {
    currentAppInstallation {
      activeSubscriptions {
        ...AppSubscriptionFragment
      }
      oneTimePurchases(first: 250, sortKey: CREATED_AT, after: $endCursor) {
        edges {
          node {
            id
            name
            test
            status
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

exports.assessPayments = assessPayments;
exports.check = check;
//# sourceMappingURL=check.js.map
