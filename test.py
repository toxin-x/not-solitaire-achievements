import json

# 1. Load the JSON file (handles \uXXXX automatically)
with open("/home/rex/Documents/notsolitare/web/saved_achievements.json", "r", encoding="utf-8") as f:
    data = json.load(f)

with open("/home/rex/Documents/notsolitare/tox_seen.json", "r", encoding="utf-8") as f:
    data2 = json.load(f)
print(data2)


icon_list = []
for i in data:
    icon_list.append(data[i]["icon"])

for i in data2["seenEmoji"].keys():
    if i not in icon_list:
        print(i)
