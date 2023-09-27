// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IReceivableCredit} from "./interfaces/IReceivableCredit.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {CreditRecord} from "./CreditStructs.sol";

//* Reserved for Richard review, this contract is for Arf case.

contract ReceivableCredit is BaseCredit, IReceivableCredit {
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivable,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount
    ) external {
        poolConfig.onlyProtocolAndPoolOn();
        onlyEAServiceAccount();

        bytes32 creditHash = getCreditHash(receivable.receivableAsset, receivable.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            false
        );

        //* Reserved for Richard review, is there any action for receivable?
    }

    function drawdownWithReceivable(uint256 receivableId, uint256 amount) external {}

    function makePaymentWithReceivable(uint256 receivableId, uint256 amount) external {}

    function refreshCredit(uint256 receivableId) external returns (CreditRecord memory cr) {}

    function triggerDefault(uint256 receivableId) external returns (uint256 losses) {}

    function closeCredit(uint256 receivableId) external {}

    function pauseCredit(uint256 receivableId) external {}

    function unpauseCredit(uint256 receivableId) external {}

    function updateYield(uint256 receivableId, uint256 yieldInBps) external {}

    function getCreditHash(
        address receivableAsset,
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(receivableAsset, receivableId));
    }
}
