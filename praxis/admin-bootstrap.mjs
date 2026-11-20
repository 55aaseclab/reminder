export const adminBootstrap = {
  input: 'reminderData', flag: 'reminder-data',
  create({ data, directory, keyFile, spaceId }) {
    const spacesFile = directory + '/reminder-business-spaces.json';
    return { configuration: { url: 'http://127.0.0.1:4322/api/business', spacesFile }, files: [
      { file: spacesFile, value: { spaces: { [spaceId]: data } } },
      { file: directory + '/reminder-managed.json', value: { REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: keyFile, REMINDER_BUSINESS_SPACES_FILE: spacesFile } },
    ] };
  },
};
