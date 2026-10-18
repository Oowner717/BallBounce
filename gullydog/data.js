/*
 * data.js — the flavour of the place, as plain data. Shop types and their signs,
 * the paint on the walls, what people wear, what they say. Shared by the world
 * generator (which picks), the texture painter (which draws every sign once),
 * and the HUD (which shows the speech).
 *
 * Every business name here is invented. Nothing is a real brand.
 */

export const DOG_NAME = 'Bhura';

/* --------------------------------------------------------------- shop types */

/**
 * name/hi are parallel arrays: the English and Devanagari lines of the same sign.
 * signBg/signFg are pairs picked together. goods is the palette for whatever is
 * stacked on the shelves and spilling onto the pavement.
 * food: 'beg' — the owner may toss scraps to a dog who sits nicely nearby.
 *       'steal' — something tasty sits on an open counter.
 */
export const SHOP_TYPES = {
  sweets: {
    name: ['Sharma Sweets', 'Gupta Mithai Bhandar', 'Annapurna Sweets'],
    hi: ['शर्मा स्वीट्स', 'गुप्ता मिठाई भंडार', 'अन्नपूर्णा स्वीट्स'],
    sub: ['Pure Ghee Sweets & Namkeen', 'Samosa • Jalebi • Kachori', 'Since 1972'],
    signs: [['#c0392b', '#ffe066'], ['#f39c12', '#7a1010'], ['#ffd400', '#b3001b']],
    goods: ['#f5a623', '#ffd36b', '#e8743b', '#fff1c9', '#d35400'],
    food: 'beg', weight: 2,
  },
  chai: {
    name: ['Raju Chai Corner', 'Krishna Tea Stall'],
    hi: ['राजू चाय कॉर्नर', 'कृष्णा टी स्टॉल'],
    sub: ['Adrak Chai • Bun Maska', 'Kulhad Chai Rs 10'],
    signs: [['#1e7b3c', '#ffffff'], ['#5b2a86', '#ffd400']],
    goods: ['#b5651d', '#e9d8a6', '#94d2bd'],
    food: 'beg', weight: 1,
  },
  kirana: {
    name: ['Balaji General Store', 'Laxmi Kirana Store', 'Ram Provision Store'],
    hi: ['बालाजी जनरल स्टोर', 'लक्ष्मी किराना स्टोर', 'राम प्रोविज़न स्टोर'],
    sub: ['All Daily Needs Available', 'Atta • Dal • Chawal • Masale', 'Home Delivery'],
    signs: [['#1d4e89', '#ffffff'], ['#d62828', '#ffffff'], ['#f77f00', '#ffffff']],
    goods: ['#e63946', '#f1c453', '#2a9d8f', '#e9c46a', '#8ecae6', '#ffb703'],
    weight: 3,
  },
  chemist: {
    name: ['Ganesh Medical Store', 'Shiv Chemist', 'Jan Seva Pharmacy'],
    hi: ['गणेश मेडिकल स्टोर', 'शिव केमिस्ट', 'जन सेवा फार्मेसी'],
    sub: ['All Medicines Available', '24 Hours Open', 'Chemist & Druggist'],
    signs: [['#ffffff', '#0b7a3e'], ['#0b7a3e', '#ffffff'], ['#e8f6ff', '#c1121f']],
    goods: ['#ffffff', '#cde7f0', '#f4a261', '#90be6d'],
    weight: 2,
  },
  mobile: {
    name: ['New Mobile Point', 'Hello Mobile Repair', 'Smart Mobile World'],
    hi: ['न्यू मोबाइल पॉइंट', 'हेलो मोबाइल रिपेयर', 'स्मार्ट मोबाइल वर्ल्ड'],
    sub: ['Recharge • Repairing • Accessories', 'Sale & Service', 'All SIM Available'],
    signs: [['#ff006e', '#ffffff'], ['#3a0ca3', '#ffd60a'], ['#06d6a0', '#14213d']],
    goods: ['#222222', '#4cc9f0', '#f72585', '#fefae0'],
    weight: 2,
  },
  tailor: {
    name: ['Bombay Tailors', 'Fashion Point Tailors', 'Perfect Fit Tailors'],
    hi: ['बॉम्बे टेलर्स', 'फैशन पॉइंट टेलर्स', 'परफेक्ट फिट टेलर्स'],
    sub: ['Gents & Ladies Tailoring', 'Alteration Done Here', 'Blouse Specialist'],
    signs: [['#14213d', '#fca311'], ['#8338ec', '#ffffff']],
    goods: ['#e63946', '#457b9d', '#f1faee', '#ffb4a2'],
    weight: 1,
  },
  saree: {
    name: ['Laxmi Saree Centre', 'Rani Cloth House', 'Shringar Saree Palace'],
    hi: ['लक्ष्मी साड़ी सेंटर', 'रानी क्लॉथ हाउस', 'शृंगार साड़ी पैलेस'],
    sub: ['Wedding Collection', 'Silk • Cotton • Georgette', 'Fixed Price Shop'],
    signs: [['#9d0208', '#ffba08'], ['#ff5d8f', '#ffffff'], ['#6a040f', '#ffd166']],
    goods: ['#d81b60', '#ff7f27', '#0f9d58', '#2a52be', '#f6c700', '#7b1fa2'],
    weight: 2,
  },
  hardware: {
    name: ['Shree Hardware', 'Om Sai Electricals', 'Jai Hind Hardware'],
    hi: ['श्री हार्डवेयर', 'ओम साई इलेक्ट्रिकल्स', 'जय हिंद हार्डवेयर'],
    sub: ['Paint • Pipe • Sanitary', 'Wiring & Repair', 'Wholesale & Retail'],
    signs: [['#ffd60a', '#003566'], ['#003566', '#ffd60a']],
    goods: ['#6c757d', '#adb5bd', '#ffd60a', '#d00000', '#495057'],
    weight: 1,
  },
  dhaba: {
    name: ['Annapurna Dhaba', 'Hotel Shiv Sagar', 'Punjabi Dhaba'],
    hi: ['अन्नपूर्णा ढाबा', 'होटल शिव सागर', 'पंजाबी ढाबा'],
    sub: ['Pure Veg • Thali Rs 80', 'Family Restaurant', 'Dal Makhani • Tandoori Roti'],
    signs: [['#2b9348', '#ffffff'], ['#bb3e03', '#ffffff'], ['#ffba08', '#370617']],
    goods: ['#f4a261', '#e9c46a', '#ffffff'],
    food: 'beg', weight: 1,
  },
  pan: {
    name: ['Raju Pan Bhandar', 'Banarasi Pan Corner'],
    hi: ['राजू पान भंडार', 'बनारसी पान कॉर्नर'],
    sub: ['Meetha Pan Special', 'Cold Drinks Available'],
    signs: [['#70e000', '#1b4332'], ['#ff4d6d', '#ffffff']],
    goods: ['#38b000', '#ff4d6d', '#ffd60a', '#ffffff'],
    weight: 1,
  },
  salon: {
    name: ['Royal Hair Salon', 'Style Point Unisex Salon'],
    hi: ['रॉयल हेयर सैलून', 'स्टाइल पॉइंट सैलून'],
    sub: ['Hair Cut • Shave • Facial', 'A/C Salon'],
    signs: [['#000000', '#ffd60a'], ['#3c096c', '#ffffff']],
    goods: ['#e0e1dd', '#778da9', '#ff006e'],
    weight: 1,
  },
  jeweller: {
    name: ['Taj Jewellers', 'Sona Chandi Bhandar'],
    hi: ['ताज ज्वैलर्स', 'सोना चांदी भंडार'],
    sub: ['Hallmark Gold', 'Gold • Silver • Diamond'],
    signs: [['#7f0000', '#ffd700'], ['#1b1b1b', '#ffd700']],
    goods: ['#ffd700', '#e0c068', '#c0c0c0'],
    weight: 1,
  },
  xerox: {
    name: ['Xerox & Lamination', 'STD ISD PCO', 'Cyber Cafe'],
    hi: ['ज़ेरॉक्स और लेमिनेशन', 'एसटीडी आईएसडी पीसीओ', 'साइबर कैफ़े'],
    sub: ['Print • Scan • Spiral Binding', 'Local & Long Distance Calls', 'Online Forms Filled'],
    signs: [['#ffd60a', '#d00000'], ['#d00000', '#ffd60a'], ['#0077b6', '#ffffff']],
    goods: ['#ffffff', '#adb5bd', '#0077b6'],
    weight: 1,
  },
  fruit: {
    name: ['Fresh Fruit Centre', 'Mausami Juice Corner'],
    hi: ['फ्रेश फ्रूट सेंटर', 'मौसमी जूस कॉर्नर'],
    sub: ['Seasonal Fruits', 'Fresh Juice Rs 30'],
    signs: [['#2d6a4f', '#ffffff'], ['#f77f00', '#ffffff']],
    goods: ['#ffb703', '#fb8500', '#d00000', '#70e000', '#ffd60a'],
    weight: 1,
  },
  flour: {
    name: ['Durga Atta Chakki'],
    hi: ['दुर्गा आटा चक्की'],
    sub: ['Pure Wheat Atta • Besan'],
    signs: [['#ffffff', '#9d0208']],
    goods: ['#f8f1e5', '#e9d8a6', '#c9b79c'],
    weight: 1,
  },
  bangles: {
    name: ['Shringar Bangle Store', 'Choodi Bazaar'],
    hi: ['शृंगार चूड़ी स्टोर', 'चूड़ी बाज़ार'],
    sub: ['Glass & Lac Bangles', 'Bindi • Mehndi • Cosmetics'],
    signs: [['#ff006e', '#ffe5ec'], ['#8338ec', '#ffbe0b']],
    goods: ['#ff006e', '#ffbe0b', '#3a86ff', '#8338ec', '#fb5607'],
    weight: 1,
  },
  shoes: {
    name: ['Ramesh Footwear', 'Chappal Ghar'],
    hi: ['रमेश फुटवियर', 'चप्पल घर'],
    sub: ['Sale 50% Off', 'Gents • Ladies • Kids'],
    signs: [['#d00000', '#ffffff'], ['#023e8a', '#ffffff']],
    goods: ['#6f4518', '#000000', '#a68a64', '#d00000'],
    weight: 1,
  },
};

/** Weighted list by frontage. Main roads get everything; galis get corner shops. */
export const SHOP_MIX = {
  main: ['sweets', 'kirana', 'chemist', 'mobile', 'saree', 'hardware', 'dhaba', 'jeweller', 'xerox', 'shoes', 'salon', 'tailor', 'bangles', 'fruit'],
  bazaar: ['kirana', 'saree', 'bangles', 'mobile', 'tailor', 'shoes', 'hardware', 'sweets', 'pan', 'chemist', 'xerox', 'flour'],
  plaza: ['sweets', 'pan', 'kirana', 'fruit', 'bangles'],
  market: ['kirana', 'fruit', 'flour', 'pan'],
  gali: ['kirana', 'pan', 'tailor', 'flour', 'xerox', 'salon'],
};

/** Upper-floor signs: clinics, tuition, offices. Painted on the same atlas. */
export const UPPER_SIGNS = [
  ['Dr. Verma Clinic', 'डॉ. वर्मा क्लिनिक', '#ffffff', '#c1121f'],
  ['Success Coaching Classes', 'सक्सेस कोचिंग क्लासेज़', '#ffd60a', '#14213d'],
  ['Sai Dental Care', 'साई डेंटल केयर', '#e0fbfc', '#005f73'],
  ['Shubh Labh Finance', 'शुभ लाभ फाइनेंस', '#003049', '#fcbf49'],
  ['Computer Classes', 'कंप्यूटर क्लासेज़', '#7209b7', '#ffffff'],
  ['Guest House', 'गेस्ट हाउस', '#2b9348', '#ffffff'],
];

/** Wall advertisements, hand-painted. [line1, line2, bg, fg] */
export const WALL_ADS = [
  ['TUITION', 'Class 1 to 12 • 98765 43210', '#ffffff', '#1d3557'],
  ['VOTE FOR', 'CLEAN STREETS', '#f1faee', '#e63946'],
  ['SHAKTI CEMENT', 'Mazboot Ghar Ka Raaz', '#d62828', '#ffffff'],
  ['DHOOM DHADAKA', 'Now Showing at Raj Talkies', '#ffbe0b', '#3a0ca3'],
  ['CHAMPION DIGITAL', 'Wedding Photo & Video', '#3a86ff', '#ffffff'],
  ['DO NOT STICK BILLS', 'By Order', '#ffffff', '#000000'],
];

/* ------------------------------------------------------------------ colours */

export const WALL_COLORS = [
  '#e8a0b4', '#f2c14e', '#7ec8c4', '#9bc15b', '#f4e3c1', '#e07a5f', '#8fb3e0',
  '#c7a0d9', '#f5b971', '#d9d4c7', '#b5d6a7', '#e6c79c', '#ff9f68', '#6fb3b8',
  '#f6d6ad', '#c96b6b', '#a3c4bc', '#ffd6a5', '#bde0fe', '#e9edc9',
];
export const TRIM_COLORS = ['#f2efe6', '#f7f4ea', '#4a4036', '#2f5d62', '#8c3b3b', '#e9d8a6'];
export const SHUTTER_COLORS = ['#8b8f92', '#77808a', '#3e6fa8', '#4a8a5a', '#9a9a8e'];
export const AWNING_COLORS = ['#2f6db5', '#2f6db5', '#3e9b55', '#e67e22', '#f1c40f', '#8e2c3a', '#c0392b', '#16a085'];
export const DOOR_COLORS = ['#2b59c3', '#1b998b', '#8d0801', '#5e548e', '#3d405b', '#6a994e'];

export const SKIN_TONES = ['#8d5524', '#a0662f', '#c68642', '#b07040', '#7a4a2a', '#d49a6a', '#5c3a21', '#9c6644'];
export const HAIR_COLORS = ['#1b1714', '#1b1714', '#1b1714', '#2e211a', '#3b2a1e', '#8a8a8a', '#d8d8d8', '#a34a28'];

export const CLOTHES = {
  shirt: ['#f5f5f0', '#a8c5e0', '#6d8fb3', '#8c2f39', '#6b705c', '#7d7d7d', '#222222', '#e9c46a', '#f4a6a6', '#a3b18a', '#5e81ac', '#d6ccc2'],
  pants: ['#2b3a55', '#1f1f1f', '#555b6e', '#8a7f6a', '#5a4632', '#3c4f76', '#2f2f2f'],
  kurta: ['#f8f4e3', '#fffdf5', '#f4a259', '#a7c957', '#8ecae6', '#e9d8a6', '#ffcad4', '#bde0fe'],
  saree: ['#d81b60', '#ff7f27', '#0f9d58', '#2a52be', '#f6c700', '#c62828', '#7b1fa2', '#00897b', '#ec407a', '#8e1b3a', '#ff5722', '#26a69a'],
  saree2: ['#ffd54f', '#ffffff', '#ff8a65', '#81d4fa', '#c5e1a5', '#f8bbd0', '#ffcc80', '#b39ddb'],
  dupatta: ['#ffeb3b', '#ff4081', '#00e5ff', '#76ff03', '#ff9100', '#ffffff', '#e040fb'],
  kid: ['#1565c0', '#ffffff', '#c62828', '#2e7d32', '#f9a825', '#6a1b9a', '#00838f'],
  khaki: ['#b9a26b', '#a89160'],
  saffron: ['#ff8f00', '#f57c00'],
  turban: ['#ff9800', '#e53935', '#1e88e5', '#fdd835', '#8e24aa', '#ffffff', '#43a047'],
};

export const VEHICLE_COLORS = {
  autoCng: [['#2e9e4f', '#f5c518'], ['#2a8f47', '#f2c21a']],
  autoMumbai: [['#151515', '#f5c518']],
  car: ['#f2f2f2', '#c8ccd0', '#b71c1c', '#6c757d', '#1f4e79', '#7b1e2b', '#e8e2d0', '#2f3e46'],
  taxi: [['#f5c518', '#151515']],
  scooter: ['#c62828', '#f2f2f2', '#212121', '#1565c0', '#8e8e8e', '#6d1b2b', '#00796b', '#f9a825'],
  bus: [['#c0392b', '#f2e6c9'], ['#1e6fb5', '#f2f2f2'], ['#2a9d5c', '#f2f2f2'], ['#e67e22', '#fff3d6']],
  truck: [['#e67e22', '#2c6fbb'], ['#2c6fbb', '#f1c40f'], ['#c0392b', '#27ae60']],
  cycle: ['#111111', '#111111', '#2b2b2b', '#5b1f1f'],
};

/* ------------------------------------------------------------------- speech */

/** Each line is [what they say, what it means]. The HUD shows both. */
export const SPEECH = {
  shoo: [['Hatt!', 'Get away!'], ['Chal hatt!', 'Scram!'], ['Shoo! Shoo!', ''], ['Jaa yahan se!', 'Go away!'], ['Bhaag!', 'Run off!']],
  startled: [['Arre baap re!', 'Oh my god!'], ['Oye!', 'Hey!'], ['Kya hai?!', "What is it?!"], ['Arre!', 'Whoa!'], ['Darr gaya main!', 'You scared me!']],
  pet: [['Aww, kitna pyaara!', 'So cute!'], ['Aaja beta', 'Come here, dear'], ['Good boy, Bhura!', ''], ['Shabash!', 'Well done!'], ['Kaise ho, Bhura?', 'How are you, Bhura?'], ['Arre mera sher!', 'My little lion!']],
  feed: [['Le, kha le', 'Here, eat'], ['Biscuit khayega?', 'Want a biscuit?'], ['Le beta, roti', 'Here dear, a roti'], ['Bhookha hai kya?', 'Are you hungry?']],
  driver: [['Dekh ke!', 'Watch it!'], ['Arre yaar!', 'Oh come on!'], ['Hato hato!', 'Move, move!'], ['Side do!', 'Make way!'], ['Kutte ko hatao!', 'Move that dog!']],
  thief: [['Chor! Pakdo!', 'Thief! Catch him!'], ['Mera samosa!', 'My samosa!'], ['Ruk ja!', 'Stop right there!']],
  kids: [['Ball laa, Bhura!', 'Bring the ball, Bhura!'], ['Chhakka!', 'Six!'], ['Howzat!', ''], ['Out hai!', "He's out!"], ['Bhura ne pakda!', 'Bhura caught it!']],
  kidsThanks: [['Thank you, Bhura!', ''], ['Shabash Bhura!', 'Well done, Bhura!'], ['Ek aur baar!', 'One more time!']],
  chatter: [['Kya haal hai?', "How's it going?"], ['Bas, badhiya', 'All good'], ['Kitne ka hai?', 'How much?'], ['Bahut mehenga!', 'Too expensive!'], ['Chalo chalo', "Let's go"], ['Haan ji', 'Yes, sir'], ['Theek hai', 'Okay'], ['Accha?', 'Really?'], ['Kal milte hain', 'See you tomorrow'], ['Garmi bahut hai', "It's so hot"], ['Bus kab aayegi?', "When's the bus coming?"]],
  vendor: {
    chai: [['Chai! Garam chai!', 'Tea! Hot tea!'], ['Adrak wali chai!', 'Ginger tea!']],
    samosa: [['Garam samose!', 'Hot samosas!'], ['Jalebi! Garam garam!', 'Jalebi, piping hot!']],
    veg: [['Taaza sabzi!', 'Fresh vegetables!'], ['Aloo pyaaz tamatar!', 'Potatoes, onions, tomatoes!'], ['Bhindi le lo!', 'Get your okra!']],
    fruit: [['Kele le lo!', 'Bananas!'], ['Meethe aam!', 'Sweet mangoes!']],
    flower: [['Phool maala!', 'Flower garlands!'], ['Genda le lo!', 'Marigolds!']],
  },
  aunty: [['Aaja Bhura, khaana!', 'Come Bhura, food!'], ['Kahan tha tu?', 'Where were you?'], ['Doodh pee le', 'Drink some milk']],
  priest: [['Prasad le lo', 'Take the offering'], ['Jai ho!', 'Glory!']],
  cop: [['Chalo, aage badho!', 'Move along!'], ['Rukk!', 'Stop!']],
  dogGrowl: [['Grrrr...', ''], ['Wuff! Grr!', '']],
};
