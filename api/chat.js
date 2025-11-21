import admin from 'firebase-admin';

// 防止冷启动重复初始化
if (!admin.apps.length) {
    // 从 Vercel 环境变量中读取私钥
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (e) {
            console.error("❌ 私钥解析失败，请检查环境变量格式", e);
        }
    } else {
        console.error("❌ 未找到 FIREBASE_CREDENTIALS 环境变量");
    }
}

const db = admin.firestore();

export default async function handler(req, res) {
    // 1. 允许跨域 (CORS)，这样你的网页才能调用这个 API
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // --- GET: 获取最新的留言 ---
        if (req.method === 'GET') {
            const snapshot = await db.collection('messages')
                .orderBy('timestamp', 'desc')
                .limit(50) // 最多获取50条
                .get();
            
            const messages = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                // 把 Firestore 的特殊时间格式转换成普通字符串
                let timeStr = "刚刚";
                if (data.timestamp && data.timestamp._seconds) {
                    timeStr = new Date(data.timestamp._seconds * 1000).toLocaleString('zh-CN');
                }
                messages.push({ 
                    id: doc.id, 
                    content: data.content, 
                    time: timeStr 
                });
            });
            
            res.status(200).json(messages);
        } 
        // --- POST: 发送新留言 ---
        else if (req.method === 'POST') {
            // 兼容处理：有的请求体是对象，有的是字符串
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { content } = body;

            if (!content || !content.trim()) {
                return res.status(400).json({ error: '内容不能为空' });
            }

            await db.collection('messages').add({
                content: content,
                timestamp: admin.firestore.FieldValue.serverTimestamp() // 使用服务器时间
            });

            res.status(200).json({ success: true });
        } 
        else {
            res.status(405).json({ error: 'Method not allowed' });
        }
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
