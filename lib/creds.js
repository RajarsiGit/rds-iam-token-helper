// Parse credentials pasted from the AWS credentials file, Bash exports or
// PowerShell `$Env:` lines (all formats CloudKeeper's popup offers).

const grab = (text, name) => {
  const m = new RegExp(name + "\\s*[=:]\\s*[\"']?([^\\s\"']+)", "i").exec(text);
  return m ? m[1] : null;
};

export function parseCredentialsText(text) {
  const accessKeyId = grab(text, "aws_access_key_id");
  const secretAccessKey = grab(text, "aws_secret_access_key");
  const sessionToken = grab(text, "aws_session_token");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Could not find aws_access_key_id / aws_secret_access_key in the pasted text");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}
