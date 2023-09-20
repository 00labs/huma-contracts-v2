import fs from "fs";
import readline from "readline";
import { ethers } from "hardhat";

async function genFunctionKeys(sourceFile: string, destFile: string) {
    const fileStream = fs.createReadStream(sourceFile);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    const keys: { [key: string]: string } = {};
    for await (const line of rl) {
        const lineTrimmed = line.trim();
        // example error line: error insufficientReceivableAmount();
        // get key insufficientReceivableAmount() from line
        if (lineTrimmed.startsWith("error ")) {
            const key = lineTrimmed.split(" ")[1].replace(";", "");
            keys[key] = "";
        }
    }

    fs.writeFileSync(destFile, JSON.stringify(keys));
}

async function genFunctionIds(sourceFile: string, destFile: string) {
    const errorFunctions = require(sourceFile);
    for (const errFunc of Object.keys(errorFunctions)) {
        const errFuncId = ethers.utils
            .keccak256(ethers.utils.toUtf8Bytes(errFunc))
            .substring(0, 10);
        console.log(`${errFunc} selectId is ${errFuncId}`);
        errorFunctions[errFunc] = errFuncId;
    }
    fs.writeFileSync(destFile, JSON.stringify(errorFunctions));
}

async function addContractComments(sourceFile: string, contractFile: string) {
    const data = fs.readFileSync(contractFile, { flag: "a+" });
    let content = data.toString();
    const errorFunctions = require(sourceFile);
    for (const errFunc of Object.keys(errorFunctions)) {
        let oldStr = `error ${errFunc};`;
        let newStr = `error ${errFunc}; // ${errorFunctions[errFunc]}`;
        if (!content.includes(newStr)) {
            content = content.replace(oldStr, newStr);
        }
    }
    fs.writeFileSync(contractFile, content);
}

async function main() {
    const sourceFile = "./error-functions.json";
    const destFile = "./scripts/error-functions.json";
    const errorFile = "./contracts/Errors.sol";

    await genFunctionKeys(errorFile, destFile);
    await genFunctionIds(sourceFile, destFile);
    await addContractComments(sourceFile, errorFile);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
