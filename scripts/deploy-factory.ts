import { ethers } from "hardhat";

async function main() {
    console.log(
        ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address"],
                [
                    "0x674b6cCB1c83C009631C99A8Aa1Fc6E989D23951",
                    "0x9c37fe88D3406775c46C585b1F588FBb0d451eD7",
                ],
            ),
        ),
    );
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
