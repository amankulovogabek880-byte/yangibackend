-- MUAMMO 2: Conversation.chatType maydonini qo'shish
-- (private | group | supergroup | channel — Bot API va GramJS'dan aniqlanadi)
ALTER TABLE "Conversation" ADD COLUMN "chatType" TEXT;