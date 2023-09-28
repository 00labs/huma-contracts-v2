// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord, CreditConfig} from "../../CreditStructs.sol";

//* Reserved for Richard review, to be deleted
// Delete this interface because of no real case

interface ICredit {
    // /**
    //  * @notice Approves the credit with the terms provided.
    //  * @param borrower the borrower address
    //  * @param creditLimit the credit limit of the credit line
    //  * @param remainingPeriods the number of periods before the credit line expires
    //  * @param yieldInBps expected yield expressed in basis points, 1% is 100, 100% is 10000
    //  * @param committedAmount the credit that the borrower has committed to use. If the used credit
    //  * is less than this amount, the borrower will charged yield using this amount.
    //  * @param revolving indicates if the underlying credit line is revolving or not
    //  * @dev only Evaluation Agent can call
    //  */
    // function approveCredit(
    //     address borrower,
    //     uint96 creditLimit,
    //     uint16 remainingPeriods,
    //     uint16 yieldInBps,
    //     uint96 committedAmount,
    //     bool revolving
    // ) external;

    function closeCredit(bytes32 creditHash) external;

    function drawdown(bytes32 creditHash, uint256 borrowAmount) external;

    function extendCreditLineDuration(bytes32 creditHash, uint256 numOfPeriods) external;

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function pauseCredit(bytes32 creditHash) external;

    function refreshCredit(bytes32 creditHash) external returns (CreditRecord memory cr);

    function triggerDefault(bytes32 creditHash) external returns (uint256 losses);

    // function updateAvailableCredit(bytes32 creditHash, uint96 newAvailableCredit) external;

    // function updateYield(address borrower, uint yieldInBps) external;

    function unpauseCredit(bytes32 creditHash) external;

    function creditRecordMap(bytes32 creditHash) external view returns (CreditRecord memory);

    function creditConfigMap(bytes32 creditHash) external view returns (CreditConfig memory);

    // function getCreditHash(address borrower) external view returns (bytes32 creditHash);

    function isApproved(bytes32 creditHash) external view returns (bool);

    function isDefaultReady(bytes32 creditHash) external view returns (bool isDefault);

    function isLate(bytes32 creditHash) external view returns (bool lateFlag);
}
