// What a delivery driver can do in the driver portal. Answers the help assistant for the
// "driver" audience (see services/assistant.service.js). Same rules as the other catalogues:
// who may do what is read from the routes' guards, steps use labels that are on screen, and
// tests/assistant.test.js fails when an entry names a route that does not exist or a route
// under MOUNTS is left undescribed.

const AUDIENCE = 'driver';

const MOUNTS = ['/api/driver'];

const AREAS = {
  deliveries: 'Deliveries',
  account:    'Your account',
};

const STARTERS = ['driver-orders', 'driver-complete', 'driver-collect-payment', 'driver-availability', 'driver-navigate'];

const INTRO = 'Ask me how to do something in the driver portal — for example "how do I mark a delivery as done?" or "do I collect cash?". I will tell you how, or say plainly if that is something the office does.';

const CAPABILITIES = [
  // ── DELIVERIES ─────────────────────────────────────────────────────────────
  {
    id: 'driver-dashboard',
    area: 'deliveries',
    title: 'See my active deliveries and my numbers',
    summary: 'Your dashboard shows the deliveries you are on right now and counts of what you have completed.',
    keywords: ['dashboard', 'active deliveries', 'my deliveries', 'what am i delivering', 'completed today', 'total completed', 'how many deliveries', 'my stats', 'my work today', 'home screen', 'two orders', 'more than one order', 'multiple deliveries', 'several orders at once'],
    routes: ['GET /api/driver/me'],
    page: '/driver/dashboard',
    steps: [
      'Open Dashboard.',
      'The cards show Active Deliveries, Completed Today and Total Completed. Your active deliveries are listed below them.',
    ],
  },
  {
    id: 'driver-orders',
    area: 'deliveries',
    title: 'See all orders assigned to me',
    summary: 'Every order the office has given you, with filters for the ones in progress and the finished ones.',
    keywords: ['my orders', 'where are my orders', 'assigned orders', 'orders list', 'what orders do i have', 'new order', 'order assigned to me', 'past deliveries', 'delivery history', 'completed orders', 'find an order', 'no orders', 'orders not showing', 'app shows no orders', 'empty list', 'nothing assigned'],
    routes: ['GET /api/driver/orders', 'GET /api/driver/orders/:id'],
    page: '/driver/orders',
    steps: [
      'Open My Orders.',
      'Use the filters — Active, Preparing, Completed or All — to find an order, then open it for the details.',
    ],
    notes: ['You only see orders assigned to you. The office assigns them; you cannot pick up an order yourself.', 'Nothing showing? The office has not assigned you anything yet — check you are switched to Available and call them if you expect work.'],
  },
  {
    id: 'driver-navigate',
    area: 'deliveries',
    title: 'Get directions, call or message the customer',
    summary: 'Each order has the delivery address, the customer\'s phone number, and buttons to navigate, call or WhatsApp them.',
    keywords: ['directions', 'navigate', 'maps', 'google maps', 'find the address', 'customer address', 'where do i deliver', 'call customer', 'phone customer', 'customer number', 'whatsapp customer', 'message customer', 'customer not answering', 'exact pin', 'location'],
    routes: ['GET /api/driver/orders/:id'],
    page: '/driver/orders',
    steps: [
      'Open the order.',
      'Tap Navigate (exact pin) if the customer shared their location, or Open in Maps to search by the written address.',
      'Use the phone button to call the customer, or WhatsApp to message them that you are arriving.',
    ],
    notes: ['If the customer does not answer, call the office for help rather than leaving the goods.'],
  },
  {
    id: 'driver-collect-payment',
    area: 'deliveries',
    title: 'Do I collect money on this delivery?',
    summary: 'Every order shows a banner saying whether to collect cash, or whether it is already paid.',
    keywords: ['collect cash', 'collect money', 'payment on delivery', 'cash on delivery', 'do i collect payment', 'already paid', 'not marked paid', 'customer paid', 'how much to collect', 'take money', 'mpesa payment', 'pay the rider', 'amount to collect'],
    routes: ['GET /api/driver/orders/:id'],
    page: '/driver/orders',
    steps: [
      'Open the order and read the banner under the order details:',
      '"Already paid — do not collect cash": hand over the goods, take no money.',
      '"Collect KES … cash on delivery": collect exactly that amount before you hand over.',
      '"Not marked paid — call the office before handing over": do not hand over until the office confirms.',
    ],
    notes: ['You cannot record a payment in the portal. The office marks orders paid.'],
  },
  {
    id: 'driver-complete',
    area: 'deliveries',
    title: 'Mark a delivery as done',
    summary: 'When the goods are handed over, confirm the delivery. You can add a photo, who received it, and a note as proof.',
    keywords: ['mark delivered', 'complete delivery', 'finish delivery', 'delivery done', 'confirm delivery', 'handed over', 'proof of delivery', 'take photo', 'recipient name', 'delivered', 'close the order', 'end delivery', 'mark as delivered', 'cannot see deliver button', 'no deliver button', 'mark as delivered missing', 'button missing', 'cannot mark delivered', 'forgot to mark', 'forgot to mark delivered'],
    routes: ['PATCH /api/driver/orders/:id/complete'],
    page: '/driver/dashboard',
    steps: [
      'Open Dashboard (or My Orders) and find the delivery.',
      'Tap Mark as Delivered.',
      'Optionally take a photo of the delivered goods, type the name of the person who received them, and add a note (for example "Left with the shop attendant").',
      'Tap Confirm delivery.',
    ],
    notes: [
      'The button only appears for orders that are Out for Delivery. If an order is not showing it, ask the office to mark it out for delivery first.',
      'A photo is optional but protects you if a delivery is ever questioned.',
    ],
  },
  {
    id: 'driver-availability',
    area: 'deliveries',
    title: 'Switch myself available or unavailable',
    summary: 'Tell the system whether you can take deliveries right now.',
    keywords: ['available', 'unavailable', 'go offline', 'go online', 'off duty', 'on duty', 'break', 'stop getting orders', 'available for orders', 'not working today', 'lunch', 'finished for the day', 'toggle availability', 'bike broke down', 'breakdown', 'puncture', 'vehicle problem', 'cannot continue', 'out of fuel'],
    routes: ['PATCH /api/driver/availability'],
    page: '/driver/dashboard',
    steps: ['Open Dashboard.', 'Use the Available for orders switch. It reads Unavailable when you are off.'],
    notes: [
      'Customers choosing a preferred rider at checkout only see riders who are available.',
      'It does not remove orders already assigned to you — finish or tell the office about those.',
      'If your vehicle breaks down mid-delivery, call the office straight away so they can arrange another driver.',
    ],
  },

  // ── YOUR ACCOUNT ───────────────────────────────────────────────────────────
  {
    id: 'driver-login',
    area: 'account',
    title: 'Sign in to the driver portal',
    summary: 'Sign in with the phone number and password the office gave you.',
    keywords: ['sign in', 'log in', 'login', 'cannot log in', 'how do i get in', 'my account', 'first time', 'password the office gave me', 'account locked', 'locked out'],
    routes: ['POST /api/auth/login'],
    page: '/login',
    steps: ['Open the sign-in page.', 'Enter your phone number and password.'],
    notes: ['If your account is locked, ask the office to unlock it.'],
  },
  {
    id: 'driver-forgot-password',
    area: 'account',
    title: 'I forgot my password',
    summary: 'Get a 6-digit code by SMS and choose a new password, or ask the office to reset it.',
    keywords: ['forgot password', 'reset password', 'lost password', 'new password', 'change password', 'change my password', 'password not working', 'reset code', 'wrong password'],
    routes: ['POST /api/auth/forgot-password', 'POST /api/auth/reset-password'],
    page: '/forgot-password',
    steps: [
      'On the sign-in page open Forgot password, enter your phone number and tap Send reset code.',
      'Enter the 6-digit code from the SMS and choose a new password.',
    ],
    notes: ['No SMS? Ask your admin to reset your password from the Drivers page.'],
  },
  {
    id: 'driver-photo',
    area: 'account',
    title: 'Change my profile photo',
    summary: 'Add or change the photo shown on your dashboard.',
    keywords: ['profile photo', 'change photo', 'my picture', 'avatar', 'upload photo', 'selfie', 'profile picture', 'change my picture'],
    routes: ['POST /api/auth/avatar'],
    page: '/driver/dashboard',
    steps: ['Open Dashboard.', 'Tap your picture (Change photo) and choose a new one.'],
  },
];

const NOT_SUPPORTED = [
  {
    id: 'no-driver-decline',
    title: 'Accept, decline or swap an order',
    keywords: ['decline order', 'refuse order', 'reject order', 'accept order', 'swap order', 'give order to another driver', 'cannot deliver', 'too far', 'choose my orders', 'pick an order', 'reassign'],
    answer: 'Orders are assigned to you by the office. The portal has no accept, decline or swap button.',
    workaround: 'Call your supervisor or admin and tell them you cannot take it — they can reassign it.',
  },
  {
    id: 'no-driver-start-delivery',
    title: 'Mark an order as preparing or out for delivery',
    keywords: ['out for delivery', 'start delivery', 'mark preparing', 'begin delivery', 'on my way', 'dispatch', 'leaving now', 'order not showing mark as delivered', 'start route'],
    answer: 'Only the office can move an order to Preparing or Out for Delivery. You can only mark it Delivered, and only once it is Out for Delivery.',
    workaround: 'If you have collected the goods and the order is not yet Out for Delivery, ask the office to update it.',
  },
  {
    id: 'no-driver-confirm-payment',
    title: 'Record or confirm a customer payment',
    keywords: ['record payment', 'confirm payment', 'mark paid', 'customer paid me', 'enter mpesa code', 'cash received', 'payment received', 'mpesa confirmation'],
    answer: 'Drivers cannot record or confirm payments in the portal.',
    workaround: 'Hand over any cash you collect to the office. A supervisor or admin confirms the payment on the order.',
  },
  {
    id: 'no-driver-cancel',
    title: 'Cancel an order or change its address',
    keywords: ['cancel order', 'cancel delivery', 'change address', 'wrong address', 'customer moved', 'reschedule', 'change delivery time', 'failed delivery', 'customer refused', 'return goods'],
    answer: 'Drivers cannot cancel, reschedule or edit an order.',
    workaround: 'Call the office straight away, explain what happened, and follow their instructions. Do not mark the order Delivered unless the goods were handed over.',
  },
  {
    id: 'no-driver-earnings',
    title: 'See my pay or earnings, or find out how I get paid',
    keywords: ['my pay', 'get paid', 'how to get paid', 'earnings', 'salary', 'commission', 'how much did i earn', 'payment for deliveries', 'wages', 'allowance', 'fuel money', 'delivery fee for me'],
    answer: 'The portal does not show pay or earnings — only your delivery counts.',
    workaround: 'Ask your admin or supervisor about pay.',
  },
  {
    id: 'no-driver-edit-details',
    title: 'Change my name, phone number or vehicle details',
    keywords: ['change vehicle', 'update vehicle', 'vehicle plate', 'new motorbike', 'change my number', 'change phone number', 'change my name', 'update my details', 'number plate', 'new bike'],
    answer: 'Drivers cannot edit these details in the portal.',
    workaround: 'Ask your admin — they can update your vehicle details from the Drivers page. For a new phone number or name, tell your admin.',
  },
  {
    id: 'no-driver-other-orders',
    title: 'See other drivers\' orders or all orders',
    keywords: ['other drivers', 'all orders', 'other riders orders', 'see everyone orders', 'who is delivering what', 'unassigned orders', 'available orders', 'take someone else order'],
    answer: 'You only see orders assigned to you.',
    workaround: 'If you have capacity for more, tell the office and they can assign you extra orders.',
  },
];

module.exports = { AUDIENCE, MOUNTS, AREAS, STARTERS, INTRO, CAPABILITIES, NOT_SUPPORTED };
