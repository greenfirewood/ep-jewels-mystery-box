import { BillingError } from '../error.mjs';
import { graphqlClientClass } from '../clients/admin/graphql/client.mjs';
import '@shopify/admin-api-client';
import 'lossless-json';
import '../types.mjs';
import 'compare-versions';
import { APP_SUBSCRIPTION_FRAGMENT } from './types.mjs';
import { convertLineItems } from './utils.mjs';

const SUBSCRIPTION_QUERY = `
${APP_SUBSCRIPTION_FRAGMENT}
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
            throw new BillingError({
                message: 'Attempted to look for purchases without billing configs',
                errorData: [],
            });
        }
        const GraphqlClient = graphqlClientClass({ config });
        const client = new GraphqlClient({ session });
        const response = await client.request(SUBSCRIPTION_QUERY);
        if (!response.data?.currentAppInstallation?.activeSubscriptions) {
            return { activeSubscriptions: [] };
        }
        const activeSubscriptions = response.data.currentAppInstallation.activeSubscriptions;
        activeSubscriptions.forEach((subscription) => {
            if (subscription.lineItems) {
                subscription.lineItems = convertLineItems(subscription.lineItems);
            }
        });
        return {
            activeSubscriptions,
        };
    };
}

export { subscriptions };
//# sourceMappingURL=subscriptions.mjs.map
