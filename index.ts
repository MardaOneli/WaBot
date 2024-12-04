import { Boom } from '@hapi/boom'; // Import library untuk menangani error
import NodeCache from 'node-cache'; // Import library untuk caching
import readline from 'readline'; // Import library untuk input dari pengguna
import makeWASocket, {
	AnyMessageContent,
	BinaryInfo,
	delay,
	DisconnectReason,
	downloadAndProcessHistorySyncNotification,
	encodeWAM,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	getHistoryMsg,
	isJidNewsletter,
	makeCacheableSignalKeyStore,
	makeInMemoryStore,
	proto,
	useMultiFileAuthState,
	WAMessageContent,
	WAMessageKey
} from '@whiskeysockets/baileys'; // Import library untuk WhatsApp Web API
import open from 'open'; // Import library untuk membuka URL di browser
import fs from 'fs'; // Import library untuk sistem file
import P from 'pino'; // Import library untuk logging

// Setup logger untuk mencatat aktivitas
const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'));
logger.level = 'trace'; // Set level logging ke 'trace'

// Konfigurasi flags untuk pengaturan
const useStore = !process.argv.includes('--no-store'); // Menggunakan store jika tidak ada argumen --no-store
const doReplies = process.argv.includes('--do-reply'); // Mengaktifkan balasan otomatis jika ada argumen --do-reply
const usePairingCode = process.argv.includes('--use-pairing-code'); // Menggunakan kode pairing jika ada argumen --use-pairing-code

// Cache untuk menghitung ulang pesan yang gagal
const msgRetryCounterCache = new NodeCache(); // Membuat cache baru untuk menghitung pesan yang gagal
const onDemandMap = new Map<string, string>(); // Map untuk menyimpan permintaan sinkronisasi

// Antarmuka readline untuk input pengguna
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve)); // Fungsi untuk menanyakan input dari pengguna

// Setup store untuk menyimpan data koneksi WA
const store = useStore ? makeInMemoryStore({ logger }) : undefined; // Membuat store di memori jika diizinkan
store?.readFromFile('./baileys_store_multi.json'); // Membaca data store dari file

// Simpan store setiap 10 detik
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json'); // Menyimpan data store ke file
}, 10_000);

// Fungsi untuk memulai koneksi
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info'); // Menggunakan state otentikasi
	const { version, isLatest } = await fetchLatestBaileysVersion(); // Mengambil versi terbaru dari WA Web
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`); // Menampilkan versi yang digunakan

	// Membuat socket untuk koneksi WA
	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode, // Menampilkan QR di terminal jika tidak menggunakan kode pairing
		auth: {
			creds: state.creds, // Kredensial otentikasi
			keys: makeCacheableSignalKeyStore(state.keys, logger), // Kunci untuk meng-cache sinyal
		},
		msgRetryCounterCache, // Cache untuk menghitung pesan yang gagal
		generateHighQualityLinkPreview: true, // Menghasilkan pratinjau tautan berkualitas tinggi
		getMessage, // Fungsi untuk mendapatkan pesan
	});

	store?.bind(sock.ev); // Mengikat store ke event socket

	// Kode pairing untuk klien Web
	if (usePairingCode && !sock.authState.creds.registered) {
		const phoneNumber = await question('Please enter your phone number:\n'); // Meminta nomor telepon
		const code = await sock.requestPairingCode(phoneNumber); // Meminta kode pairing
		console.log(`Pairing code: ${code}`); // Menampilkan kode pairing
	}

	// Fungsi untuk mengirim pesan dengan status mengetik
	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid); // Berlangganan ke status kehadiran pengguna
		await delay(500); // Menunggu 500ms
		await sock.sendPresenceUpdate('composing', jid); // Mengirim pembaruan kehadiran 'sedang mengetik'
		await delay(2000); // Menunggu 2 detik
		await sock.sendPresenceUpdate('paused', jid); // Mengirim pembaruan kehadiran 'terhenti'
		await sock.sendMessage(jid, msg); // Mengirim pesan
	};

	// Memproses event yang terjadi
	sock.ev.process(async (events) => {
		// Menangani pembaruan koneksi
		if (events['connection.update']) {
			const update = events['connection.update'];
			const { connection, lastDisconnect } = update;

			if (connection === 'close') {
				// Menghubungkan kembali jika tidak keluar
				if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
					startSock(); // Memulai kembali koneksi
				} else {
					console.log('Connection closed. You are logged out.'); // Menampilkan pesan jika keluar
				}
			}
			console.log('connection update', update); // Menampilkan pembaruan koneksi
		}

		// Menyimpan kredensial jika diperbarui
		if (events['creds.update']) {
			await saveCreds(); // Menyimpan kredensial
		}

		// Menangani berbagai event
		if (events['labels.association']) {
			console.log(events['labels.association']); // Menampilkan asosiasi label
		}

		if (events['labels.edit']) {
			console.log(events['labels.edit']); // Menampilkan edit label
		}

		if (events.call) {
			console.log('recv call event', events.call); // Menampilkan event panggilan yang diterima
		}

		// Menangani riwayat pesan
		if (events['messaging-history.set']) {
			const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set'];
			if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
				console.log('received on-demand history sync, messages=', messages); // Menampilkan sinkronisasi riwayat yang diminta
			}
			console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`); // Menampilkan jumlah chat, kontak, dan pesan
		}

		// Menangani pesan baru
		if (events['messages.upsert']) {
			const upsert = events['messages.upsert'];
			const m = upsert.messages[0];
            const mText = m.message.conversation;
			console.log('recv messages ', JSON.stringify(upsert, undefined, 2)); // Menampilkan pesan yang diterima

			// if (upsert.type === 'notify') {
			//     for (const msg of upsert.messages) {
			//         if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
			//             const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text; // Mengambil teks pesan
			//             if (text === "requestPlaceholder" && !upsert.requestId) {
			//                 const messageId = await sock.requestPlaceholderResend(msg.key); // Meminta pengiriman ulang pesan
			//                 console.log('requested placeholder resync, id=', messageId); // Menampilkan ID pengiriman ulang
			//             } else if (upsert.requestId) {
			//                 console.log('Message received from phone, id=', upsert.requestId, msg); // Menampilkan pesan yang diterima dari telepon
			//             }

			//             // Menangani permintaan sinkronisasi riwayat
			//             if (text === "onDemandHistSync") {
			//                 const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!); // Mengambil riwayat pesan
			//                 console.log('requested on-demand sync, id=', messageId); // Menampilkan ID sinkronisasi
			//             }
			//         }

			//     }
			// }
			// Mengirim balasan jika pesan dari pengirim
            if (mText === "!test" && m.key.fromMe) {
                // await sock.readMessages([m.key]); // Menandai pesan sebagai dibaca
                console.log('replying to', m.key.remoteJid); // Menampilkan ID penerima
                await sendMessageWTyping({ text: 'WhatsApp Bot is Online!' }, m.key.remoteJid); // Mengirim balasan
            }

            /* Fitur!!!! */
			
		}

		// Menangani pembaruan pesan
		if (events['messages.update']) {
			console.log(JSON.stringify(events['messages.update'], undefined, 2)); // Menampilkan pembaruan pesan
			for (const { key, update } of events['messages.update']) {
				if (update.pollUpdates) {
					const pollCreation = await getMessage(key); // Mengambil pesan terkait polling
					if (pollCreation) {
						console.log('got poll update, aggregation: ', getAggregateVotesInPollMessage({
							message: pollCreation,
							pollUpdates: update.pollUpdates,
						})); // Menampilkan agregasi suara dari polling
					}
				}
			}
		}

		// Menangani pembaruan penerimaan pesan
		if (events['message-receipt.update']) {
			console.log(events['message-receipt.update']); // Menampilkan pembaruan penerimaan pesan
		}

		// Menangani reaksi pesan
		if (events['messages.reaction']) {
			console.log(events['messages.reaction']); // Menampilkan reaksi pesan
		}

		// Menangani pembaruan kehadiran
		if (events['presence.update']) {
			console.log(events['presence.update']); // Menampilkan pembaruan kehadiran
		}

		// Menangani pembaruan chat
		if (events['chats.update']) {
			console.log(events['chats.update']); // Menampilkan pembaruan chat
		}

		// Menangani pembaruan kontak
		if (events['contacts.update']) {
			for (const contact of events['contacts.update']) {
				if (typeof contact.imgUrl !== 'undefined') {
					const newUrl = contact.imgUrl === null
						? null
						: await sock!.profilePictureUrl(contact.id!).catch(() => null); // Mengambil URL gambar profil baru
					console.log(`contact ${contact.id} has a new profile pic: ${newUrl}`); // Menampilkan URL gambar profil baru
				}
			}
		}

		// Menangani penghapusan chat
		if (events['chats.delete']) {
			console.log('chats deleted ', events['chats.delete']); // Menampilkan chat yang dihapus
		}
	});

	return sock; // Mengembalikan socket

	// Fungsi untuk mendapatkan pesan berdasarkan kunci
	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!); // Memuat pesan dari store
			return msg?.message || undefined; // Mengembalikan pesan atau undefined
		}
		return proto.Message.fromObject({}); // Mengembalikan objek pesan kosong jika store tidak ada
	}
};

startSock(); // Memulai koneksi socket
