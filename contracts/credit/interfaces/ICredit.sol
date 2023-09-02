// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditConfig, CreditRecord, ReceivableInfo} from "../CreditStructs.sol";
import {CalendarUnit} from "../../SharedDefs.sol";

interface ICredit {
    function approveCredit(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        bool revolving
    ) external;

    function closeCredit(bytes32 creditHash) external;

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external;

    function extendCreditLineDuration(bytes32 creditHash, uint256 numOfPeriods) external;

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function pauseCredit(bytes32 creditHash) external;

    function refreshCredit(bytes32 creditHash) external returns (CreditRecord memory cr);

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function triggerDefault(bytes32 creditHash) external returns (uint256 losses);

    function updateAvailableCredit(bytes32 creditHash, uint96 newAvailableCredit) external;

    function updateYield(address borrower, uint yieldInBps) external;

    function unpauseCredit(bytes32 creditHash) external;

    function creditRecordMap(bytes32 creditHash) external view returns (CreditRecord memory);

    function creditConfigMap(bytes32 creditHash) external view returns (CreditConfig memory);

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function getCreditHash(address borrower) external view returns (bytes32 creditHash);

    function isApproved(bytes32 creditHash) external view returns (bool);

    function isDefaultReady(bytes32 creditHash) external view returns (bool isDefault);

    function isLate(bytes32 creditHash) external view returns (bool lateFlag);
}
