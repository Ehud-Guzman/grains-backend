// What a customer (or a visitor who has not signed in) can do on the storefront, in the words
// they use. Answers the shop's help assistant for the "customer" audience — see
// services/assistant.service.js and utils/capabilityCatalog.js (the admin one) for how entries
// are read. Same rules apply:
//   * Who may do each thing is read from the routes' guards, not written here. Signed-in-only
//     features are the ones whose routes need a customer token; a visitor is told to sign in.
//   * `routes` gate the entry (all must be allowed). `covers` are routes the feature also uses
//     that must not narrow who it is offered to (e.g. a guest and a customer order via different
//     routes). A feature with no API of its own sets `clientOnly: true` (add `signedIn: true` if
//     it needs an account).
//   * Keep steps to labels that are on screen. tests/assistant.test.js fails on a route that
//     does not exist, an uncovered route in MOUNTS, or a page link that opens for nobody.

const AUDIENCE = 'customer';

// Route prefixes this catalogue is responsible for (every route under them must be described
// or listed, with a reason, in the test's UNLISTED table).
const MOUNTS = [
  '/api/auth', '/api/products', '/api/orders', '/api/settings', '/api/payments',
  '/api/alerts', '/api/lists', '/api/coupons', '/api/promotions', '/api/branches',
];

const AREAS = {
  shopping:  'Browsing & products',
  ordering:  'Cart & checkout',
  payment:   'Paying',
  orders:    'Your orders',
  account:   'Your account',
  shop:      'The shop',
};

const STARTERS = ['checkout', 'track-order', 'shop-browse', 'pay-mpesa', 'cancel-order', 'register'];

const INTRO = 'Ask me anything about shopping with us — for example "how do I pay with M-Pesa?" or "how do I track my order?". I will tell you how, or say plainly if we do not offer it.';

const CAPABILITIES = [
  // ── BROWSING & PRODUCTS ────────────────────────────────────────────────────
  {
    id: 'shop-browse',
    area: 'shopping',
    title: 'Find and search products',
    summary: 'Browse everything the shop sells, search by name, and narrow the list with filters.',
    keywords: ['find product', 'search', 'browse', 'what do you sell', 'catalogue', 'catalog', 'look for maize', 'rice', 'beans', 'filter', 'categories', 'price range', 'in stock', 'products list', 'shop'],
    routes: ['GET /api/products', 'GET /api/products/categories', 'GET /api/products/suggestions'],
    page: '/shop',
    steps: [
      'Open Shop in the menu.',
      'Type what you want in the search box (for example maize, beans or rice).',
      'Use Filters to narrow by category, packaging size, in-stock only, or a price range.',
    ],
  },
  {
    id: 'product-details',
    area: 'shopping',
    title: 'See a product\'s sizes, prices and bulk discounts',
    summary: 'Each product page shows the varieties and packaging sizes, whether it is in stock, and cheaper prices when you buy more.',
    keywords: ['product details', 'bag sizes', 'packaging size', 'variety', 'bulk discount', 'wholesale price', 'volume pricing', 'cheaper if i buy more', 'price per bag', 'how much is a bag', 'quote only', 'out of stock', 'is it in stock', '50kg', '90kg', '100kg'],
    routes: ['GET /api/products/:id'],
    page: '/shop',
    steps: [
      'Open Shop and tap a product.',
      'Pick the Variety and the Packaging Size.',
      'Change the Quantity — the volume pricing list shows the price each once you reach a higher quantity.',
    ],
    notes: [
      'A product marked Quote Only has no listed price; use "Questions about this product?" to ask the shop.',
      'Out-of-stock items show "Out of Stock" instead of the Add to Cart button — see the stock alert below.',
    ],
  },
  {
    id: 'price-trends',
    area: 'shopping',
    title: 'Compare prices over time',
    summary: 'See how a product\'s price has moved, and compare several products on one chart.',
    keywords: ['price history', 'price trend', 'compare prices', 'has the price gone up', 'price chart', 'cheaper before', 'price changes', 'when is it cheapest', 'compare grain prices'],
    routes: ['GET /api/products/:id/price-history'],
    page: '/compare-prices',
    steps: [
      'Open Compare Prices.',
      'Search for a product to add, then add more to compare them.',
      'A product page also has its own Price History section.',
    ],
    notes: ['If a product is new, you may see "Not enough price history yet".'],
  },
  {
    id: 'promotions',
    area: 'shopping',
    title: 'See current offers and promotions',
    summary: 'The shop\'s current banners and seasonal offers appear on the home page.',
    keywords: ['offers', 'promotions', 'deals', 'discounts', 'specials', 'sale', 'banners', 'seasonal offer', 'what is on offer'],
    routes: ['GET /api/promotions'],
    page: '/',
    steps: ['Open the home page and look at the offers and banners near the top.'],
    notes: ['Have a discount code? Enter it at checkout — see "Use a coupon code".'],
  },
  {
    id: 'branch-pick',
    area: 'shopping',
    title: 'Choose which branch you buy from',
    summary: 'Prices, stock and delivery depend on the branch. The shop picks the nearest one for you, and you can switch.',
    keywords: ['change branch', 'switch branch', 'nearest branch', 'which branch', 'nakuru', 'nairobi', 'busia', 'branch', 'different shop', 'my location', 'closest shop'],
    routes: ['GET /api/branches', 'GET /api/branches/nearest'],
    steps: [
      'If you allow location access, the nearest branch that can deliver to you is chosen automatically.',
      'To pick one yourself, use the branch switcher in the top menu. Your choice is remembered.',
    ],
    notes: ['A cart holds items from one branch only — if you switch branch with items in your cart, the cart is cleared.'],
  },

  // ── CART & CHECKOUT ────────────────────────────────────────────────────────
  {
    id: 'cart',
    area: 'ordering',
    title: 'Add to cart and review your cart',
    summary: 'Collect what you want to buy, change quantities, and check the subtotal before you check out.',
    keywords: ['add to cart', 'my cart', 'shopping cart', 'basket', 'remove from cart', 'change quantity', 'update cart', 'empty cart', 'cart total', 'view cart', 'buy'],
    clientOnly: true,
    page: '/cart',
    steps: [
      'On a product page choose the Variety, Packaging Size and Quantity, then tap Add to Cart.',
      'Open your cart (Your Cart) to change quantities or remove an item.',
      'Tap Checkout when you are ready.',
    ],
    notes: ['Your cart is saved on this device automatically, so you can keep browsing.'],
  },
  {
    id: 'checkout',
    area: 'ordering',
    title: 'Place an order',
    summary: 'Check out in five steps: Contact, Delivery, Payment, Review and Confirm. You do not need an account unless the shop requires one.',
    keywords: ['place order', 'make an order', 'how to order', 'buy', 'checkout', 'check out', 'order now', 'complete purchase', 'guest checkout', 'order without account', 'order without registering', 'submit order'],
    routes: ['POST /api/orders/guest'],
    covers: ['POST /api/orders'],
    page: '/checkout',
    steps: [
      'Open your cart and tap Checkout.',
      'Contact: enter your Full Name and Phone Number (email is optional; add a KRA PIN if you want a tax receipt for your business).',
      'Delivery: choose Home Delivery or Pickup from Shop. For delivery, enter your address (or pick a saved one) and tap Use My Location so the delivery fee is worked out accurately. You can also pick a Preferred Rider and a preferred date, and add Special Instructions.',
      'Payment: choose M-Pesa, Pay on Pickup or Pay on Delivery.',
      'Review: check the items and totals, add a coupon code if you have one, then place the order.',
      'Confirm: you get an order reference — keep it to track your order.',
    ],
    notes: [
      'If the shop only accepts orders from signed-in customers you will see "Sign In Required".',
      'Some branches have a minimum order value or a minimum number of bags.',
    ],
  },
  {
    id: 'delivery-fee',
    area: 'ordering',
    title: 'Delivery fee, delivery area and minimum order',
    summary: 'How delivery is priced, how far we deliver, and whether there is a minimum order.',
    keywords: ['delivery fee', 'delivery cost', 'how much is delivery', 'do you deliver', 'delivery area', 'delivery radius', 'free delivery', 'minimum order', 'minimum bags', 'how far', 'delivery charge', 'shipping', 'pickup only', 'collect from shop'],
    routes: ['GET /api/settings', 'GET /api/settings/delivery-fee'],
    page: '/checkout',
    steps: [
      'The delivery fee is shown at checkout once you choose Home Delivery.',
      'Tap Use My Location so the fee reflects your distance from the shop; without it you are charged the standard fee.',
      'Checkout tells you if the order is below the branch minimum, and what the minimum is.',
    ],
    notes: [
      'Each branch sets its own fee, either one flat fee or by distance.',
      'If you are beyond the branch\'s delivery distance, you can still order for pickup.',
    ],
  },
  {
    id: 'coupon',
    area: 'ordering',
    title: 'Use a coupon code',
    summary: 'Enter a discount code at checkout to take money off your order.',
    keywords: ['coupon', 'discount code', 'promo code', 'voucher', 'apply code', 'enter code', 'redeem', 'code not working', 'invalid coupon', 'discount'],
    routes: ['POST /api/coupons/validate'],
    page: '/checkout',
    steps: [
      'At the Review step, type the code in the Coupon code box and apply it.',
      'The discount appears in your totals. Use the remove button next to it to take it off.',
    ],
    notes: ['A code can have a minimum order, a limit on total uses, or a limit per customer, so a valid-looking code may still be refused.'],
  },
  {
    id: 'saved-lists',
    area: 'ordering',
    title: 'Save a shopping list to reorder later',
    summary: 'Keep your regular items in named lists and load a whole list into your cart in one tap.',
    keywords: ['saved list', 'shopping list', 'favourites', 'favorites', 'wishlist', 'save for later', 'regular order', 'repeat order', 'my lists', 'load list', 'standing order'],
    routes: ['GET /api/lists', 'POST /api/lists', 'GET /api/lists/:id', 'PUT /api/lists/:id', 'DELETE /api/lists/:id'],
    page: '/lists',
    steps: [
      'On a product page tap the Save to list icon.',
      'Open My Lists to create a list (type a List name), see what is in it, or remove an item.',
      'Tap Load to cart to put the whole list in your cart.',
    ],
  },
  {
    id: 'stock-alerts',
    area: 'ordering',
    title: 'Get alerted when a price drops or an item is back in stock',
    summary: 'Ask us to tell you when a product gets cheaper, or when something that was sold out comes back.',
    keywords: ['price alert', 'price drop', 'notify me', 'back in stock', 'out of stock alert', 'restock', 'tell me when available', 'alert me', 'my alerts', 'cheaper'],
    routes: ['GET /api/alerts', 'POST /api/alerts', 'DELETE /api/alerts/:id'],
    page: '/alerts',
    steps: [
      'Open the product and tap Alert me if price drops, or Notify me when back in stock.',
      'See and remove your alerts any time under My Alerts.',
    ],
  },

  // ── PAYING ─────────────────────────────────────────────────────────────────
  {
    id: 'payment-methods',
    area: 'payment',
    title: 'Which ways can I pay?',
    summary: 'You can pay by M-Pesa, pay when you collect your order, or pay when it is delivered.',
    keywords: ['payment methods', 'how can i pay', 'ways to pay', 'accept mpesa', 'cash on delivery', 'pay on pickup', 'pay on delivery', 'pay cash', 'pay later', 'payment options'],
    routes: ['GET /api/settings'],
    page: '/checkout',
    steps: [
      'At the Payment step you will see the options this branch accepts: M-Pesa, Pay on Pickup (for orders you collect) and Pay on Delivery (for delivered orders).',
    ],
    notes: ['A branch can switch any of these off, so you only see the ones currently available.'],
  },
  {
    id: 'pay-mpesa',
    area: 'payment',
    title: 'Pay with M-Pesa',
    summary: 'You get an M-Pesa prompt on your phone; enter your PIN to pay.',
    keywords: ['pay with mpesa', 'mpesa', 'm-pesa', 'stk push', 'mpesa prompt', 'pay by phone', 'mobile money', 'mpesa pin', 'safaricom', 'paybill', 'till number'],
    routes: ['POST /api/payments/mpesa/initiate', 'GET /api/payments/status/:orderId'],
    covers: ['POST /api/payments/status/:orderId'],
    page: '/checkout',
    steps: [
      'At the Payment step choose M-Pesa and enter the M-Pesa number to charge (it can be different from your contact number).',
      'Place the order. A payment prompt appears on that phone — enter your M-Pesa PIN.',
      'Stay on the page: it shows "Payment Confirmed!" when the payment goes through.',
    ],
    notes: ['You pay through the prompt — there is no paybill or till number to type in.'],
  },
  {
    id: 'pay-problem',
    area: 'payment',
    title: 'The M-Pesa prompt did not come, or payment failed',
    summary: 'Your order is saved. You can ask for the prompt again, or switch to paying when you collect or receive the order.',
    keywords: ['mpesa not working', 'no prompt', 'prompt did not come', 'payment failed', 'payment timed out', 'stk not received', 'try again', 'retry payment', 'pay later instead', 'switch payment', 'change payment method', 'wrong number', 'mpesa failed', 'cancelled payment', 'paid but not confirmed', 'order still says unpaid', 'paid but unpaid', 'says unpaid', 'mpesa deducted', 'deducted twice', 'charged twice', 'paid twice', 'double charged', 'money taken but no order'],
    routes: ['POST /api/payments/mpesa/initiate', 'POST /api/payments/change-method'],
    page: '/track',
    steps: [
      'On the payment screen after a failure or time-out, choose to try again, or choose Pay on Pickup (Pay on Delivery for a delivered order).',
      'Later, open your order (Track Your Order, or your order under My Orders). If it shows Payment needed you can tap Pay with M-Pesa, or choose Pay on pickup / Pay on delivery instead.',
    ],
    notes: [
      'Check you entered the right M-Pesa number and that the phone is on and has signal.',
      'If M-Pesa took your money but the order does not show as paid, contact the shop with the M-Pesa confirmation message so they can confirm it.',
    ],
  },

  // ── YOUR ORDERS ────────────────────────────────────────────────────────────
  {
    id: 'track-order',
    area: 'orders',
    title: 'Track an order',
    summary: 'See where your order is using your phone number and order reference — no account needed.',
    keywords: ['track order', 'where is my order', 'order status', 'check order', 'order progress', 'has my order been approved', 'delivery status', 'find my order', 'order reference', 'order number', 'when will it arrive', 'did my order go through', 'order went through', 'was my order received', 'order confirmed', 'lost my order number'],
    routes: ['POST /api/orders/track'],
    covers: ['GET /api/orders/track'],
    page: '/track',
    steps: [
      'Open Track Order from the menu.',
      'Enter the phone number you used and your order reference (it looks like NAI-2026-0001 and is on your confirmation screen).',
      'Press the track button to see the latest status.',
    ],
    notes: ['Lost the reference? Signed-in customers can find every order under My Orders.'],
  },
  {
    id: 'order-statuses',
    area: 'orders',
    title: 'What does my order status mean?',
    summary: 'The stages an order goes through, from received to delivered.',
    keywords: ['order status meaning', 'what does pending mean', 'approved', 'preparing', 'out for delivery', 'ready for pickup', 'completed', 'rejected', 'declined', 'cancelled', 'status', 'stuck in pending', 'why is my order pending', 'how long until approved'],
    routes: ['POST /api/orders/track'],
    page: '/track',
    steps: [
      'Pending — received and waiting for the shop to confirm it.',
      'Approved — confirmed, and the stock is set aside for you.',
      'Preparing — being packed.',
      'Out for Delivery — on its way (for a pickup order this reads Ready for Pickup: come and collect it).',
      'Completed — delivered or collected.',
      'Rejected (shown as "Order Declined") — the shop could not fulfil it; the reason is shown.',
      'Cancelled — the order was cancelled.',
    ],
    notes: ['An order that is not approved or paid in time may be cancelled automatically; each branch sets how long that takes.'],
  },
  {
    id: 'my-orders',
    area: 'orders',
    title: 'See all my past orders',
    summary: 'Signed-in customers get a full order history with search.',
    keywords: ['my orders', 'order history', 'past orders', 'previous orders', 'dashboard', 'my dashboard', 'what did i buy', 'all my orders', 'recent orders', 'spend'],
    routes: ['GET /api/orders/my', 'GET /api/orders/my/:id', 'GET /api/orders/my/stats'],
    page: '/dashboard',
    steps: [
      'Sign in, then open My Orders.',
      'Search by order reference, or tap an order to see its items, payment and status.',
    ],
  },
  {
    id: 'cancel-order',
    area: 'orders',
    title: 'Cancel my order',
    summary: 'You can cancel an order yourself while it is still Pending (not yet approved).',
    keywords: ['cancel order', 'cancel my order', 'i changed my mind', 'stop my order', 'do not want order', 'undo order', 'cancellation', 'cancel purchase'],
    routes: ['PATCH /api/orders/:id/cancel'],
    page: '/dashboard',
    steps: [
      'Sign in and open the order from My Orders.',
      'Tap Cancel Order, then Yes, cancel.',
    ],
    notes: [
      'This is only offered while the order is Pending. Once it is approved, call or WhatsApp the shop — there is an "Ask about this order on WhatsApp" button on the order.',
      'If you had already paid, the order shows that you will be refunded; the shop arranges the refund with you.',
    ],
  },
  {
    id: 'reorder',
    area: 'orders',
    title: 'Order the same things again',
    summary: 'Put a finished order\'s items back in your cart in one tap.',
    keywords: ['reorder', 'order again', 'repeat order', 'buy again', 'same order', 'same items', 'order the same'],
    routes: ['GET /api/orders/my/:id'],
    page: '/dashboard',
    steps: [
      'Open a finished order (Completed, Rejected or Cancelled) from My Orders.',
      'Tap Reorder Same Items, then check your cart and check out.',
    ],
  },
  {
    id: 'receipt',
    area: 'orders',
    title: 'Get a receipt',
    summary: 'View and print a receipt for an order once it has been approved.',
    keywords: ['receipt', 'print receipt', 'proof of purchase', 'invoice', 'tax receipt', 'download receipt', 'vat receipt', 'kra receipt'],
    routes: ['GET /api/settings/receipt'],
    page: '/dashboard',
    steps: [
      'Sign in and open the order from My Orders.',
      'Tap View & Print Receipt (it appears once the order is no longer Pending).',
    ],
    notes: ['For a tax receipt in your business\'s name, save your KRA PIN in your profile or enter it at checkout.'],
  },
  {
    id: 'order-updates',
    area: 'orders',
    title: 'Will I get messages about my order?',
    summary: 'The shop sends a text (and an email if you gave one) when your order is approved, declined or delivered.',
    keywords: ['sms updates', 'notifications', 'will i be notified', 'text message', 'email confirmation', 'order updates', 'do you send sms', 'order confirmation message'],
    clientOnly: true,
    steps: ['Give your phone number at checkout, and an email if you want one. Messages are sent automatically as the order moves along.'],
    notes: ['Which messages are sent is set by each branch. You can always check the latest status on the Track Order page.'],
  },

  // ── YOUR ACCOUNT ───────────────────────────────────────────────────────────
  {
    id: 'register',
    area: 'account',
    title: 'Register / create an account',
    summary: 'A free account keeps your order history, saved addresses, lists and alerts.',
    keywords: ['sign up', 'register', 'create account', 'new account', 'join', 'open account', 'make an account', 'do i need an account'],
    routes: ['POST /api/auth/register'],
    page: '/register',
    steps: [
      'Open Create an account.',
      'Enter your Full Name, Phone Number and a Password (at least 8 characters). Email is optional.',
      'Tap Create Account — by doing so you agree to the Terms and Privacy Policy.',
    ],
    notes: ['You can order without an account unless the shop requires one.', 'The shop can pause new sign-ups; if so, you will be told when you try.'],
  },
  {
    id: 'login',
    area: 'account',
    title: 'Sign in',
    summary: 'Sign in with your phone number and password.',
    keywords: ['sign in', 'log in', 'login', 'access my account', 'cannot log in', 'my account'],
    routes: ['POST /api/auth/login'],
    page: '/login',
    steps: ['Open Sign In.', 'Enter your phone number and password.'],
    notes: ['Forgot your password? See "I forgot my password".'],
  },
  {
    id: 'forgot-password',
    area: 'account',
    title: 'I forgot my password',
    summary: 'Get a 6-digit code by SMS (and email, if one is on file) and choose a new password.',
    keywords: ['forgot password', 'reset password', 'lost password', 'cannot remember password', 'password reset code', 'locked out', 'account locked', 'new password'],
    routes: ['POST /api/auth/forgot-password', 'POST /api/auth/reset-password'],
    page: '/forgot-password',
    steps: [
      'Open Forgot password and enter your phone number, then tap Send reset code.',
      'Enter the 6-digit code from the SMS and choose a new password.',
    ],
    notes: ['Resetting your password also unlocks an account that was locked after too many wrong attempts.'],
  },
  {
    id: 'change-password',
    area: 'account',
    title: 'Change my password',
    summary: 'Change your password while signed in.',
    keywords: ['change password', 'update password', 'new password', 'password security', 'change my password'],
    routes: ['POST /api/auth/change-password'],
    page: '/profile',
    steps: ['Sign in and open My Profile.', 'Under Password & Security choose Change your account password.'],
  },
  {
    id: 'profile-edit',
    area: 'account',
    title: 'Update my name, email or KRA PIN',
    summary: 'Edit your personal details. Your KRA PIN is used for business tax receipts.',
    keywords: ['edit profile', 'change name', 'update email', 'change email', 'kra pin', 'my details', 'personal information', 'my profile', 'business receipt', 'tin'],
    routes: ['GET /api/auth/me', 'PUT /api/auth/me'],
    page: '/profile',
    steps: ['Open My Profile.', 'Under Personal Information change your Full Name, Email Address or KRA PIN, then Save Changes.'],
    notes: ['A KRA PIN looks like A012345678B.'],
  },
  {
    id: 'addresses',
    area: 'account',
    title: 'Save delivery addresses',
    summary: 'Save your usual addresses so you do not retype them at checkout, and mark one as the default.',
    keywords: ['save address', 'delivery address', 'add address', 'home address', 'office address', 'default address', 'remove address', 'saved addresses', 'change address'],
    routes: ['PUT /api/auth/me'],
    page: '/profile',
    steps: ['Open My Profile and find Delivery Addresses.', 'Add a label (e.g. Home, Office) and the full address, or remove or set a default on an existing one.', 'At checkout, pick a saved address instead of typing.'],
  },
  {
    id: 'promo-sms',
    area: 'account',
    title: 'Turn promotional SMS on or off',
    summary: 'Choose whether the shop may text you offers. Order updates are not affected.',
    keywords: ['stop sms', 'unsubscribe', 'promotional sms', 'marketing messages', 'stop texts', 'opt out', 'opt in', 'offers by sms', 'too many messages'],
    routes: ['PUT /api/auth/me'],
    page: '/profile',
    steps: ['Open My Profile.', 'Under Notifications switch Promotional SMS on or off.'],
  },
  {
    id: 'loyalty',
    area: 'account',
    title: 'Loyalty tiers',
    summary: 'Where the shop runs a loyalty programme, your tier (Bronze, Silver or Gold) goes up as your total spending grows.',
    keywords: ['loyalty', 'loyalty tier', 'bronze', 'silver', 'gold', 'rewards', 'points', 'vip', 'top tier', 'customer tier'],
    routes: ['GET /api/orders/my/stats'],
    page: '/dashboard',
    steps: ['Sign in and open My Orders — your tier is shown there if the shop has the programme switched on.'],
    notes: ['Each branch sets the spending amounts for each tier.'],
  },

  // ── THE SHOP ───────────────────────────────────────────────────────────────
  {
    id: 'contact-shop',
    area: 'shop',
    title: 'Contact the shop, opening hours and location',
    summary: 'Phone numbers, WhatsApp, email, hours and address for the branch you are viewing.',
    keywords: ['contact', 'phone number', 'whatsapp', 'call the shop', 'opening hours', 'business hours', 'where are you', 'address', 'location', 'email the shop', 'customer service', 'speak to someone', 'talk to a person', 'complaint', 'help'],
    routes: ['GET /api/settings'],
    steps: [
      'The shop\'s phone, WhatsApp, hours and address are at the bottom of every page.',
      'On an order, tap "Ask about this order on WhatsApp" to message the shop about that order.',
    ],
    notes: ['These are the details for the branch you have selected.'],
  },
];

const NOT_SUPPORTED = [
  {
    id: 'no-edit-placed-order',
    title: 'Change the items or address on an order I already placed',
    keywords: ['edit order', 'change my order', 'add item to order', 'remove item from order', 'change quantity after ordering', 'change delivery address after', 'wrong address', 'modify order', 'amend order'],
    answer: 'An order cannot be edited once it is placed.',
    workaround: 'If it is still Pending, cancel it and place a new one. If it has been approved, call or WhatsApp the shop and ask them to help.',
  },
  {
    id: 'no-cancel-after-approval',
    title: 'Cancel an order that has already been approved',
    keywords: ['cancel approved order', 'cancel after approval', 'cancel preparing order', 'cancel out for delivery', 'cancel button missing', 'cannot cancel'],
    answer: 'Once the shop has approved an order you can no longer cancel it yourself.',
    workaround: 'Call or WhatsApp the shop straight away (use "Ask about this order on WhatsApp") and they can cancel it for you if it has not left.',
  },
  {
    id: 'no-self-refund',
    title: 'Request a refund myself',
    keywords: ['refund', 'get my money back', 'return money', 'reverse payment', 'refund request', 'money back', 'return goods', 'return policy'],
    answer: 'There is no refund button. If you cancel a paid order the shop is told you are owed a refund.',
    workaround: 'Contact the shop with your order reference; they will refund you through M-Pesa.',
  },
  {
    id: 'no-card-payments',
    title: 'Pay by card, bank transfer or another wallet',
    keywords: ['pay by card', 'visa', 'mastercard', 'credit card', 'debit card', 'bank transfer', 'paypal', 'airtel money', 'cheque', 'pay with card', 'pay on credit', 'pay later', 'buy on credit'],
    answer: 'Only M-Pesa, pay on pickup and pay on delivery are offered.',
    workaround: 'Choose M-Pesa for instant payment, or pay cash or M-Pesa when you collect or receive the order.',
  },
  {
    id: 'no-time-slot',
    title: 'Choose an exact delivery time',
    keywords: ['delivery time', 'time slot', 'exact time', 'deliver at', 'schedule delivery', 'book a time', 'deliver tomorrow morning', 'delivery appointment'],
    answer: 'You can suggest a preferred delivery or pickup date, but not a time, and it is a request rather than a promise.',
    workaround: 'Add the preferred date at checkout and put any timing needs in Special Instructions, or call the shop to agree a time.',
  },
  {
    id: 'no-change-phone',
    title: 'Change the phone number on my account',
    keywords: ['change phone number', 'change my number', 'new phone number', 'update phone', 'lost my sim', 'different number'],
    answer: 'The phone number is your sign-in and cannot be changed from your profile.',
    workaround: 'Contact the shop and tell them your old and new numbers.',
  },
  {
    id: 'no-delete-account',
    title: 'Delete my account',
    keywords: ['delete account', 'close account', 'remove my account', 'delete my data', 'deactivate account', 'erase my details'],
    answer: 'There is no way to delete an account from the website.',
    workaround: 'Contact the shop to ask for your account to be closed. You can also switch off promotional SMS in your profile.',
  },
];

module.exports = { AUDIENCE, MOUNTS, AREAS, STARTERS, INTRO, CAPABILITIES, NOT_SUPPORTED };
