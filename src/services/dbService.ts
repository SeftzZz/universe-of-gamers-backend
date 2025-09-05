 import mongoose from "mongoose";

// export async function connectDB() {
//   const uri = process.env.MONGO_URI;
//   await mongoose.connect(uri);
//   console.log("MongoDB connected:", uri);
// }


export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("process.env.MONGO_URI is undefined. Check your .env file");
  }
  await mongoose.connect(uri);
  console.log("MongoDB connected:", uri);
}