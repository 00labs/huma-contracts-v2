async function main() {
    const input = `sender=0x22E4b789B07771Ce7f8A96c7D32aa2bf933406DF addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePrincipalPaymentAndDrawdownWithReceivable(uint256,uint256,uint256,uint256) args=[115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77], 3, 22788289443144963299136999770583787545640652083010549363838 [2.278e58], 2]
    sender=0x6546e7ab16a57b5B6911e2b8c7A184A6E06e0BC6 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePrincipalPaymentAndDrawdownWithReceivable(uint256,uint256,uint256,uint256) args=[2691, 4238513535945 [4.238e12], 215, 1983]
    sender=0x000000000000000000000000000000000000114A addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=drawdownWithReceivable(uint256,uint256,uint256) args=[3878562887641857190945011324742947258046911287696535233 [3.878e54], 465978703882356961592379874803930 [4.659e32], 0]
    sender=0x0000000000000000000000000000000000002840 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePrincipalPaymentWithReceivable(uint256,uint256,uint256) args=[5290, 1206, 1308]
    sender=0x206973206C657373207468616E206D696e2E0000 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=disburse(uint256,uint256,uint256) args=[3, 101002297727347737 [1.01e17], 199151947794161789121398819347 [1.991e29]]
    sender=0x0000000000000000000000000000000000003ee9 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=addRedemptionRequest(uint256,uint256,uint256,uint256) args=[1502, 17706 [1.77e4], 12579 [1.257e4], 13861 [1.386e4]]
    sender=0x00000000000000000000000000000000000000db addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=withdrawPoolOwnerFee(uint256,uint256) args=[0, 6]
    sender=0x0000000000000000000000000000000000000cA8 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=cancelRedemptionRequest(uint256,uint256,uint256,uint256) args=[5171, 4661, 10908 [1.09e4], 24411 [2.441e4]]
    sender=0x536565643a202573a2646970667358221220a383 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=addRedemptionRequest(uint256,uint256,uint256,uint256) args=[3792, 34417 [3.441e4], 11514 [1.151e4], 11147 [1.114e4]]
    sender=0x000000000000000000000000000000004A817C7f addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePrincipalPaymentWithReceivable(uint256,uint256,uint256) args=[772931628185164769239091166635619238658305254149721108401233174524111 [7.729e68], 115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77], 0]
    sender=0x0000000000000000000000000000000031a83Fee addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=addRedemptionRequest(uint256,uint256,uint256,uint256) args=[1, 115792089237316195423570985008687907853269984665640564039457584007913129639932 [1.157e77], 33216614510659856966940055975913017456357573107501548973788 [3.321e58], 115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]]
    sender=0x0000000000000000000000000000000000003170 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePaymentWithReceivable(uint256,uint256,uint256) args=[16888 [1.688e4], 12073 [1.207e4], 473745687804409714323878541972247001183660 [4.737e41]]
    sender=0x0000000000000000000000000000000000004035 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=deposit(uint256,uint256,uint256,uint256) args=[79648434596973584967864216352591063277839227808056240329825739938052455162707 [7.964e76], 10095 [1.009e4], 200000010082 [2e11], 16979 [1.697e4]]
    sender=0x0000000000000000000000000000000065a86c58 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=withdrawProtocolFee(uint256,uint256) args=[2189330705504424476372184687553 [2.189e30], 14282406702 [1.428e10]]
    sender=0x0000000000000000000000000000000000002949 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=refreshCredit(uint256,uint256) args=[294, 21407 [2.14e4]]
    sender=0x0000000000000000000000000000000000003DCF addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=addRedemptionRequest(uint256,uint256,uint256,uint256) args=[32458597901748140005968589770647574123769 [3.245e40], 15467101292360452382143368610670202549 [1.546e37], 8478411710415529876124 [8.478e21], 115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]]
    sender=0xF05bD1556C5a3f480a18b68bfe3A26cd6d6E0a19 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=refreshCredit(uint256,uint256) args=[3, 115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77]]
    sender=0x00000000659210e8000000000000008598a5aBF7 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePrincipalPaymentAndDrawdownWithReceivable(uint256,uint256,uint256,uint256) args=[11803 [1.18e4], 2576, 6971, 344662576652243469721435640171710866217 [3.446e38]]
    sender=0x0000000000000000000000000000000000001920 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=processYieldForLenders(uint256,uint256) args=[35983222580426468139908544811619096550624656227001345252 [3.598e55], 11548288141986360995140109898920128168056393807 [1.154e46]]
    sender=0xD4bCEBEA3a1BA12d458B7F84aF17ffde0123D016 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=makePaymentWithReceivable(uint256,uint256,uint256) args=[1, 2161940855342391292872524652586360927080670296223599743566046144126584134497 [2.161e75], 0]
    sender=0x000000000000000000000000000000000000514D addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=addRedemptionRequest(uint256,uint256,uint256,uint256) args=[115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77], 267527196642402639407305903009800009145643320047575289653 [2.675e56], 9584688538686150623 [9.584e18], 37053191810327812672267866827828780594033610945043891352933439184125 [3.705e67]]
    sender=0x000000000000000000000000000000004de940D6 addr=[test/invariant/handlers/ReceivableBackedCreditLineHandler.sol:ReceivableBackedCreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=drawdownWithReceivable(uint256,uint256,uint256) args=[3, 3119182089827284015614947261212429386472591443896914886317802037 [3.119e63], 3]`;
    const regex = /addr=\[.+\:([a-zA-Z]+)\].+calldata=([a-zA-Z]+)\([^\)]+\)\sargs=\[(.+)\]/g;
    let match;
    let result = "";

    while ((match = regex.exec(input)) !== null) {
        // console.log(`handler: ${match[1]}`);
        const functionName = match[2];
        const argsMatch = match[3];
        // console.log(`argsMatch: ${argsMatch}`);
        const args = argsMatch.split(`,`).map((arg) => {
            // console.log(`arg: ${arg.trim()}, arg0: ${arg.trim().split(` `)[0].trim()}`);
            return arg.trim().split(` `)[0].trim();
        });
        result += `${match[1]}.${functionName}(\n${args.join(",\n")}\n);\n`;
    }

    result = result.replaceAll(`LiquidityHandler`, `liquidityHandler`);
    result = result.replaceAll(`ReceivableBackedCreditLineHandler`, `rbCreditLineHandler`);

    console.log(result);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
